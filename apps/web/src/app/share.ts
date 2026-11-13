import type { Metadata } from "next";

export const SITE_NAME = "More Than Meets the AI";

/**
 * Canonical origin for share previews. Static export bakes this in, so the
 * deployed domain (or NEXT_PUBLIC_SITE_URL at build time) is what messaging apps
 * resolve the image path against.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mtmai.yashindo.syn-forge.com";

export const SHARE_IMAGE = {
  url: "/design/assets/more-than-meets-the-ai-og.png",
  width: 1200,
  height: 630,
  alt: "More Than Meets the AI — a yellow card with the game's drawing board and the line “Draw together. Outsmart the AI.”",
};

/**
 * Metadata for one page, including a complete share card.
 *
 * Next replaces a page's `openGraph` and `twitter` objects wholesale rather than
 * merging them with the layout's, so a route that sets its own title must repeat
 * the image too — otherwise the preview loses its thumbnail exactly on the links
 * people share most.
 */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  return {
    title,
    description,
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title,
      description,
      url: path,
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SHARE_IMAGE.url],
    },
  };
}
