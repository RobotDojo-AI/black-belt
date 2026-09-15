// Left-nav tree. One function, one contract:
//   visible T1 → header + its visible T2s, nested
//   hidden T1  → header and children gone (edit mode: both stay)
//   T2 with no parent, or a parent that does not exist → unnested
//   T2 whose parent exists and is hidden → not shown
// Belt never decides this.

export function isShown(row) {
  return row && row.visible !== false && row.visible !== 0;
}

export function resolveNavGroups(apiGroups = [], labels = []) {
  const groups = (apiGroups || []).filter((g) => g && g.slug);
  if (groups.length) return groups.slice();

  const seen = new Map();
  for (const label of labels || []) {
    if (!label?.parent_slug || seen.has(label.parent_slug)) continue;
    seen.set(label.parent_slug, {
      slug: label.parent_slug,
      name: label.parent_name || titleizeSlug(label.parent_slug),
      icon: 'folder',
      visible: true,
      sort_order: 999,
    });
  }
  return [...seen.values()];
}

export function shouldFlattenTopicNav(groups = []) {
  return !Array.isArray(groups) || groups.length === 0;
}

export function sortNavChildren(kids = []) {
  return (kids || []).slice().sort((a, b) => {
    const order = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (order) return order;
    return String(a.name || a.label || '').localeCompare(String(b.name || b.label || ''));
  });
}

export function navLabelSlug(label = {}) {
  return label.slug || label.context || '';
}

export function buildTopicNavModel(labels = [], groups = [], { editMode = false } = {}) {
  const t1 = sortNavChildren(resolveNavGroups(groups, labels));
  const t1BySlug = new Map(t1.map((g) => [g.slug, g]));
  const t1Slugs = new Set(t1BySlug.keys());

  const byParent = new Map();
  for (const label of labels || []) {
    if (!editMode && !isShown(label)) continue;
    const parent = label.parent_slug;
    if (!parent || !t1Slugs.has(parent)) continue;
    const bucket = byParent.get(parent) || [];
    bucket.push(label);
    byParent.set(parent, bucket);
  }

  const sections = [];
  for (const group of t1) {
    if (!editMode && !isShown(group)) continue;
    const children = sortNavChildren(byParent.get(group.slug) || []);
    if (!editMode && children.length === 0) continue;
    sections.push({ group, children });
  }

  const orphans = [];
  for (const label of labels || []) {
    if (!editMode && !isShown(label)) continue;
    const slug = navLabelSlug(label);
    if (slug && t1Slugs.has(slug)) continue;
    const parent = label.parent_slug;
    if (!parent) {
      orphans.push(label);
      continue;
    }
    if (!t1Slugs.has(parent)) orphans.push(label);
  }

  return { sections, orphans: sortNavChildren(orphans) };
}

function titleizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || slug;
}
