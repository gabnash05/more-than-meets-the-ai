declare module "atrament" {
  export default class Atrament {
    constructor(canvas: HTMLCanvasElement, config?: object);
    mode: string;
    color: string;
    weight: number;
    adaptiveStroke: boolean;
    pressureLow: number;
    pressureHigh: number;
    getSmoothingFactor(distance: number): number;
    beginStroke(x: number, y: number): void;
    draw(
      x: number,
      y: number,
      previousX: number,
      previousY: number,
      pressure?: number,
    ): { x: number; y: number };
    endStroke(x: number, y: number): void;
    destroy(): void;
  }
}
