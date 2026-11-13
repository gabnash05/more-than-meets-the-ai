import type { Metadata } from "next";
import { Suspense } from "react";
import RoomScreen from "@/features/room/RoomScreen";
import { pageMetadata } from "../share";

/**
 * Room links are shared far more than the landing page, so they carry their own
 * preview text. The image is the same card: a query string never changes which
 * exported file is served, so a per-room picture would be a lie.
 */
export const metadata: Metadata = pageMetadata({
  title: "Join a drawing room — More Than Meets the AI",
  description: "You're invited to draw against a transformer. Open the link, pick a name, and jump in.",
  path: "/room/",
});

export default function RoomPage() {
  return (
    <Suspense
      fallback={
        <main className="page-loading">
          <h1>Getting your room ready...</h1>
        </main>
      }
    >
      <RoomScreen />
    </Suspense>
  );
}
