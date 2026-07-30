export function pickActiveLessonSection({ sections, anchorTop, atStart, atEnd }) {
  if (!sections.length) return null;
  if (atStart) return sections[0].id;
  if (atEnd) return sections[sections.length - 1].id;

  return sections.reduce((closest, section) => {
    const containsAnchor = section.top <= anchorTop && section.bottom >= anchorTop;
    const distance = containsAnchor
      ? 0
      : Math.min(Math.abs(section.top - anchorTop), Math.abs(section.bottom - anchorTop));

    return distance < closest.distance ? { id: section.id, distance } : closest;
  }, { id: sections[0].id, distance: Number.POSITIVE_INFINITY }).id;
}
