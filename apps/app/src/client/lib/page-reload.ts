/** Whether this page load was itself a reload (PerformanceNavigationTiming type "reload": Safari 15, iOS 15.1). */
export function pageWasReloaded(): boolean {
  const [entry] = performance.getEntriesByType("navigation");
  return (entry as PerformanceNavigationTiming | undefined)?.type === "reload";
}
