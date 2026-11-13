import type { Metadata } from "next";
import FreeDrawScreen from "@/features/free-draw/FreeDrawScreen";

export const metadata: Metadata = {
  title: "Free Draw · More Than Meets the AI",
  description: "Draw solo and explore what the AI sees.",
};

export default function FreeDrawPage() {
  return <FreeDrawScreen />;
}
