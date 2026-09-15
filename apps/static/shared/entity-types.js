// Entity Type Registry — types that exist in robotdojo.
const ENTITY_TYPES = {};

function registerEntityType(type, config) {
  ENTITY_TYPES[type] = { type, ...config };
}

function entityIcon(type) { return ENTITY_TYPES[type]?.icon || 'link'; }
function entityLabel(type) { return ENTITY_TYPES[type]?.label || type; }
function entityLabelPlural(type) { return ENTITY_TYPES[type]?.labelPlural || type + 's'; }
function entityUrl(type, id) {
  const t = ENTITY_TYPES[type];
  if (!t?.url) return null;
  return t.url.replace('{id}', encodeURIComponent(id));
}
function entityTypeKeys() { return Object.keys(ENTITY_TYPES); }

// === Register robotdojo types ===
registerEntityType('chat',    { icon: 'chat',     label: 'Chat',    labelPlural: 'Chats',     url: '/chat?id={id}' });
// WHY non-null URLs: entityUrl(type, id) substitutes {id} with the full UUID.
// The server resolves bare UUIDs via LIKE lookup — the SPA's replaceState will
// upgrade the URL to the slug-shortId form on navigation (st_8cdd196f).
registerEntityType('person',  { icon: 'person',   label: 'Person',  labelPlural: 'People',    url: '/network/people/{id}' });
registerEntityType('company', { icon: 'business', label: 'Company', labelPlural: 'Companies', url: '/network/companies/{id}' });
