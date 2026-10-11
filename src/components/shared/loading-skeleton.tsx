import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-shimmer-wave rounded-xl bg-white/90 dark:bg-zinc-900/80 border border-slate-200 dark:border-white/[0.04]", className)}
      {...props}
    />
  )
}

export function DashboardSkeleton() {
  return (
    <div className="p-4 space-y-6">
      <Skeleton className="h-12 w-48 rounded-lg" />
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-32 rounded-3xl" />
        <Skeleton className="h-32 rounded-3xl" />
      </div>
      <Skeleton className="h-64 rounded-3xl" />
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <TransactionListSkeleton />
      </div>
    </div>
  );
}

export function TransactionListSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-4 glass p-4 rounded-2xl">
          <Skeleton className="w-12 h-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return <Skeleton className="h-48 w-full rounded-3xl" />;
}
