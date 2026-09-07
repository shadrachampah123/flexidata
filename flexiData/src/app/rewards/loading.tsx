export default function Loading() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="space-y-3">
        <div className="h-6 w-36 rounded-xl bg-black/[0.06] dark:bg-white/[0.08]" />
        <div className="h-3 w-56 rounded bg-black/[0.04] dark:bg-white/[0.04]" />
      </div>
      <div className="h-32 rounded-[1.5rem] bg-black/[0.04] dark:bg-white/[0.04]" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-28 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
        <div className="h-28 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
      </div>
      <div className="h-40 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
    </div>
  );
}
