import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PinPilot — Pinterest Video Analysis Agent",
  description:
    "An agentic pipeline that downloads Pinterest videos and analyses the hook, title, description and hashtags with AI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
