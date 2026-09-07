export default function Loading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* header skeleton */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-7 w-28 rounded-xl bg-black/[0.06] dark:bg-white/[0.08]" />
          <div className="flex gap-2">
            <div className="h-9 w-9 rounded-xl bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="h-9 w-9 rounded-xl bg-black/[0.06] dark:bg-white/[0.08]" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
          <div className="space-y-2 flex-1">
            <div className="h-3 w-24 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="h-4 w-32 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
          </div>
        </div>
      </div>

      {/* wallet skeleton */}
      <div className="h-[168px] rounded-[2rem] bg-black/[0.06] dark:bg-white/[0.06]" />

      {/* services grid skeleton */}
      <div className="grid grid-cols-3 gap-2.5">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-[104px] rounded-[1.4rem] bg-black/[0.04] dark:bg-white/[0.04]" />
        ))}
      </div>

      {/* list skeleton */}
      <div className="space-y-3">
        <div className="h-4 w-32 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
        <div className="h-24 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
        <div className="h-24 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]" />
      </div>
    </div>
  );
}
