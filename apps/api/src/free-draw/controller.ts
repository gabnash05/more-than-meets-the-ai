import { Controller, Delete, Get, Headers, HttpException, Inject, Post, Req, Res } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FreeDrawObservation } from "../../../../packages/game-contracts/src/free-draw";
import { FreeDrawError, FreeDrawService } from "./service";

export const FREE_DRAW = Symbol("free-draw");

function bearerToken(header?: string): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function throwServiceError(error: unknown, response?: ServerResponse): never {
  if (error instanceof FreeDrawError) {
    if (error.retryAfter) response?.setHeader("Retry-After", String(error.retryAfter));
    throw new HttpException({ code: error.code, message: "Free Draw request failed." }, error.status);
  }
  throw error;
}

@Controller("api/free-draw")
export class FreeDrawController {
  constructor(@Inject(FREE_DRAW) private readonly service: FreeDrawService) {}

  @Post("sessions")
  create() {
    try {
      return this.service.create();
    } catch (error) {
      return throwServiceError(error);
    }
  }

  @Get("capabilities")
  capabilities(@Headers("authorization") authorization?: string) {
    try {
      this.service.authenticate(bearerToken(authorization));
      return this.service.capabilities();
    } catch (error) {
      return throwServiceError(error);
    }
  }

  @Delete("sessions/current")
  dispose(@Headers("authorization") authorization?: string) {
    try {
      this.service.dispose(bearerToken(authorization));
      return { disposed: true };
    } catch (error) {
      return throwServiceError(error);
    }
  }

  @Post("infer")
  async infer(
    @Headers("authorization") authorization: string | undefined,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-free-draw-observation") observationHeader: string | undefined,
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const authToken = bearerToken(authorization);
    try {
      this.service.authenticate(authToken);
    } catch (error) {
      return throwServiceError(error, response);
    }
    if (contentType?.split(";")[0].trim().toLowerCase() !== "image/png") {
      throw new HttpException({ code: "content-type", message: "Expected image/png." }, 415);
    }
    if (!observationHeader || observationHeader.length > 2048) {
      throw new HttpException({ code: "invalid-observation", message: "Invalid observation header." }, 400);
    }

    let observation: FreeDrawObservation;
    try {
      observation = JSON.parse(observationHeader) as FreeDrawObservation;
    } catch {
      throw new HttpException({ code: "invalid-observation", message: "Invalid observation header." }, 400);
    }

    const controller = new AbortController();
    const onResponseClose = () => {
      if (!response.writableEnded) controller.abort("client-disconnected");
    };
    response.once("close", onResponseClose);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new FreeDrawError("payload-too-large", 413);
        chunks.push(chunk);
      }
      return await this.service.infer(authToken, observation, Buffer.concat(chunks, size), controller.signal);
    } catch (error) {
      return throwServiceError(error, response);
    } finally {
      response.off("close", onResponseClose);
    }
  }
}
