import type { Metadata } from "next";
import "./tokens.css";
import "./globals.css";
import { pageMetadata, SITE_URL } from "./share";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  icons: { icon: "/design/assets/more-than-meets-the-ai-icon.png" },
  ...pageMetadata({
    title: "More Than Meets the AI",
    description: "Make your player, grab your people, and start drawing.",
    path: "/",
  }),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
