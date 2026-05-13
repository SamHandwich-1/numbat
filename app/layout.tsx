import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";

import { CostBadge } from "@/components/shared/cost-badge";
import { getTodayCostUsd } from "@/lib/supabase/queries/sessions";

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

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Layout owns the cost number — it persists across navigation, so
  // <CostBadge /> stays mounted with one realtime channel for the whole
  // app session (step 14 wires the subscription). Fetched here as the
  // server-rendered seed; the badge subscribes for live updates.
  const initialUsd = await getTodayCostUsd();

  return (
    <html lang="en" className="dark">
      <body
        className={`${instrumentSerif.variable} ${jetbrainsMono.variable} font-mono bg-background text-foreground`}
      >
        {/*
          Sticky chrome. The header owns the persistent cost badge and
          (in slice 2b) the breadcrumb — neither belongs in the page's
          scroll content. z-40 sits below shadcn's z-50 popover content
          so filter dropdowns still overlay the header. bg-background
          makes it opaque against the scrolling list.
        */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-background px-4 py-2">
          {/* left: breadcrumb (slice 2b) */}
          <div className="text-sm text-muted-foreground" />
          {/* centre: reserved */}
          <div />
          {/* right */}
          <CostBadge initialUsd={initialUsd} />
        </header>
        {children}
      </body>
    </html>
  );
}
