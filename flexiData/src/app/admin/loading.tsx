export default function Loading() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-7 w-48 rounded-xl bg-black/[0.06] dark:bg-white/[0.08]" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1,2,3,4].map(i=> <div key={i} className="h-24 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />)}
      </div>
      <div className="h-64 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
    </div>
  );
}
