export function eventsAfterSnapshot(events, snapshotSequence, generation) {
  const representedThrough = Number.isFinite(snapshotSequence) ? snapshotSequence : 0;
  return events.filter((item) => (
    item?.generation === generation
    && Number.isFinite(item.sequence)
    && item.sequence > representedThrough
  ));
}
