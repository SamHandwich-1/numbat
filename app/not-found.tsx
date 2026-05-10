// Server-rendered 404 inside the root layout.
// Next.js's built-in fallback injects an inline <style> overriding body
// background to #fff/#000 (depending on prefers-color-scheme), defeating
// our @theme bg-background. This file replaces it with a quiet, themed
// page that lets the layout's warm-dark base show through.
export default function NotFound() {
  return (
    <main className="flex min-h-[calc(100vh-3rem)] flex-col items-center justify-center gap-3 text-foreground">
      <h1 className="font-display text-7xl italic">404</h1>
      <p className="font-mono text-sm">Page not found</p>
    </main>
  );
}
