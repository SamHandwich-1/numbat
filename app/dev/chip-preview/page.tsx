// Dev-only preview for the project chips. Reads chip colours from
// the database (per-row chip_bg / chip_fg) so changes to config/
// projects.json + a re-seed show up here without code edits.
//
// Eyeballed against both the page bg (--color-base) and the raised-
// surface card bg (--color-surface-raised) so chip contrast is
// verified in both contexts before SessionCard consumes the colours
// in step 9.
//
// Delete this route (and the parent `app/dev/` folder if it ends up
// the only thing there) once chip colours are locked in.
import { ProjectChip } from "@/components/sessions/project-chip";
import { listProjects } from "@/lib/supabase/queries/sessions";

// Bypass the RSC cache so edits to config/projects.json + a re-seed
// show up on next reload without restarting dev. The route's purpose
// is to reflect the live DB; static rendering defeats that.
export const dynamic = "force-dynamic";

export default async function ChipPreviewPage() {
  const projects = await listProjects();

  return (
    <main className="min-h-[calc(100vh-3rem)] px-8 py-12 text-foreground">
      <h1 className="font-display text-3xl italic mb-2">Chip preview</h1>
      <p className="font-mono text-sm text-muted-foreground mb-10">
        Eyeball check before chip colours are locked into SessionCard.
        Source: <code>projects.chip_bg</code> / <code>projects.chip_fg</code> per row.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-10 max-w-3xl">
        {projects.map((p) => (
          <section key={p.id} className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                On page bg (--color-base)
              </div>
              <div className="bg-background p-6 rounded-md border border-border flex items-center gap-3">
                <ProjectChip project={p} />
                <span className="font-mono text-sm text-foreground">
                  {p.slug}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                On card bg (--color-surface-raised)
              </div>
              <div className="bg-card p-6 rounded-md border border-border flex items-center gap-3">
                <ProjectChip project={p} />
                <span className="font-mono text-sm text-card-foreground">
                  {p.slug}
                </span>
              </div>
            </div>
          </section>
        ))}
      </div>

      <div className="mt-12 font-mono text-xs text-muted-foreground">
        To iterate: edit <code>config/projects.json</code>, run{" "}
        <code>pnpm db:seed</code>, reload.
      </div>
    </main>
  );
}
