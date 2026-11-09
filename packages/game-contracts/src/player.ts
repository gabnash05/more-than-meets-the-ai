export const CRAYON_COLORS = {
  red: "#FF4343",
  orange: "#FF8A1F",
  yellow: "#FFE83D",
  green: "#37D66B",
  cyan: "#27DCEB",
  blue: "#3455FF",
  purple: "#853BE8",
  pink: "#FF57B5",
} as const;
export type CrayonColor = keyof typeof CRAYON_COLORS;
export type AvatarShape = "pebble" | "droplet" | "spark" | "bean" | "cloud";
export type AvatarExpression = "smile" | "wink" | "wow" | "grin" | "sleepy";
export interface AvatarConfig {
  shape: AvatarShape;
  expression: AvatarExpression;
  color: CrayonColor;
}
export interface PlayerProfile {
  name: string;
  avatar: AvatarConfig;
}
export const DEFAULT_AVATAR: AvatarConfig = {
  shape: "pebble",
  expression: "smile",
  color: "cyan",
};
