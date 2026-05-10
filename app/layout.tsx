import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";

import { CostBadge } from "@/components/shared/cost-badge";

import "./globals.css";

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Numbat",
  description:
    "Single-operator control surface for orchestrating Claude Agent SDK sessions across multiple codebases.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${instrumentSerif.variable} ${jetbrainsMono.variable} font-mono bg-background text-foreground`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          {/* left: breadcrumb (slice 2b) */}
          <div className="text-sm text-muted-foreground" />
          {/* centre: reserved */}
          <div />
          {/* right */}
          <CostBadge initialUsd={0} />
        </header>
        {children}
      </body>
    </html>
  );
}
