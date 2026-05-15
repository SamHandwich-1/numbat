import { cn } from "@/lib/utils";

// One labelled section of the four-section debrief. Server component;
// no state, no events. The page renders five of these (or four when
// `new_concept` is absent).
//
// Tailwind v4: `whitespace-pre-line` preserves newlines in the mock
// fixture's body strings without forcing breaks at every space.
export function DebriefBlock({
  title,
  body,
  className,
}: {
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-border bg-card px-4 py-3",
        className,
      )}
    >
      <h3 className="mb-2 font-display text-lg italic">{title}</h3>
      <p className="whitespace-pre-line break-words text-sm leading-relaxed">
        {body}
      </p>
    </section>
  );
}
