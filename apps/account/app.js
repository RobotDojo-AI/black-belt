// Accounts app — settings page with section navigation

const TYPE_LABELS = { email: 'Email', calendar: 'Calendar', drive: 'Drive', contacts: 'Contacts', documents: 'Docs', sheets: 'Sheets', slides: 'Slides', task: 'Tasks', tasks: 'Tasks', sms: 'SMS', database: 'Database', mail: 'Mail', proxy: 'Proxy', voice: 'Voice', domains: 'Domains', other: 'Other' };
const TYPE_ICONS = { email: 'mail', calendar: 'calendar_month', drive: 'folder', contacts: 'contacts', documents: 'article', sheets: 'table_chart', slides: 'slideshow', task: 'task_alt', tasks: 'task_alt', sms: 'sms', database: 'database', mail: 'local_post_office', proxy: 'vpn_key', voice: 'graphic_eq', domains: 'language', other: 'extension' };
const TYPE_ORDER = ['smart_toy', 'email', 'calendar', 'drive', 'contacts', 'documents', 'sheets', 'slides', 'task', 'tasks', 'sms', 'database', 'voice', 'domains', 'other'];
const FIELD_LABELS = { api_key: 'API Key', api_secret: 'API Secret', account_sid: 'Account SID', auth_token: 'Auth Token', phone_number: 'Phone Number', secret_key: 'Secret Key', webhook_secret: 'Webhook Secret' };

function formatCredential(raw) {
  if (!raw || raw === '****' || raw === '—') return raw || '—';
  try {
    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed).filter(([, v]) => typeof v === 'string');
    if (entries.length === 1) return entries[0][1];
    return entries.map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`).join(' · ');
  } catch { return raw; }
}

// st_d9fc573b — Usage tab removed (AC 14b). 30-day spend folds into Integrations
// table. Feature Requests is the route to inbound feedback; report-issue is a
// global button (lives in shell.js). Invite a Friend is the new Invite tab.
// Launch-current navigation: payment infrastructure remains server-side, but
// account does not expose a billing or checkout tab during private beta.
const ACCOUNT_APP_CONFIG = window.RobotDojoAccountApp || {};
const ACCOUNT_ALIASES = ACCOUNT_APP_CONFIG.aliases || {};
const ROBOTDOJO_LOGO_ICON = 'robotdojo-logo';
const ROBOTDOJO_LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAYAAAA5ZDbSAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAeKADAAQAAAABAAAAeAAAAAAI4lXuAAATC0lEQVR4Ae1dZ5AcxRntnpm9vaCABAIFsISEkISIFgJOJ5kkwIDtKlPGgEk/MOAfhMK4XEARVoAzLtIvlzFlkgFD4bJJRhLBKAECJIKwMAgkQAmEhMKF3Z3g92Zv7mZ3525ndvfu5va66/YmfZ3e6+75+utvZqQYAuGnf3cOtBzrOGGJU9zq6voiXYrX7vux/LTWqy9ruYLnP9y2f0KvS2lS/kjTtZGOk6utRK1ty95pO86TWSuTeuSCxi9qFYeaJfiiBzJH6Un9CSOhTTHTlnAcO49DKTVhJHVhZu11Vto6+8GL61blCdTIQU0SfMFDreMMPblET+hTrEy2V6r0uoSwstY600rPe/jCps29Cg/Ci9ogLHPJIht64sZEsjS5TIgNgLKMUzLhQShQcz34soeccRnNXCM1bZRjW6EokZouHNveYdrGzIcvlDXVi2uuB6dFeraeMEKTyxbAhsA4OuKGahGDSKjmCIbyNBH6U+TAONCuJ0aOGPMIZUAR+xqFG5eDqqFp5ccNSi8G52qPYMv+JOStNw9+xpGOXJd3sgYOao5g206utC1zCxWnsIGyjGOZxpth4wwWuZoj+MGL5dfStv9i1IWvGmUZh3EHC3FhyxkehbApxkAu0dr6h2yHudJIJkqWhjKUZZySwoNQoObmwR4HP3mkfWJSSzxq1OnNWZgqMRfyLuW2UJth4BBmxlqRtrPn/e38hg35ArVxVJM9mNSQsAZdP9XM2DfVGXIn50A2Fhv44z7P8Zps23FarZJLHGq2B7NyXrhzibnUFHpLW3tuFtTYoAtDWMuumWfM9WRqdWvUasX89dKhQzXUCdGIRWAGHbfmTGZoNO4hQTBJ5VqwOzxjX+MwPURCzd6Dhwh/JaupCC4J0eAWUAQPbv5Kll4RXBKiwS2gCB7c/JUsvSK4JESDW0ARPLj5K1l6RXBJiAa3wJAgGG48ORulj6ugc77LNbPbL5as5ms+b0iM2vcgxxDTbNOaBBP4KLhPJETBAk9foMos9rTZk0cO627LDkxaPNe8oO333Wf7IvfONJmJI+Gg7eyAc8EGzRZrszu+/HjFnQe092GubtJ9utgw79fZFtgHz7WFMx+2wikavMyl1qdZFuFFE+XJR9pizF4wVXY2KA2Af/WNEC+uhpG6f4uDVUsH3iNwxpZyHXJfLDT52JIbEsuKCl6lE31SvZYF7SfiWaDrgOd8He4ScIdBxcycQbhKBQ+bDAk+ZXZC7DtKyyP4yx22WLSSOIdNqYpyyFRqhtB0rGlhzRLtbTG2v1ueGv5SFXNxk6pq9ZpTO0drRsOvUP5LUQHdzqaRycBa9knw/KMTYuxoTVidPRirS2LLdlssfnOACM5jUQotkWQHsOB8f59tpW9YkRq5PU+kggPeHaoS5qR2H6ob9S/qRuJncCQHuR1It5hcniHo/fUzQerGr+y8nspey3O81l/lcPMJRBpDNrAiZnoieTkxJJaBomWcrEoPRs89Rjcan5K6PiFHbH5JuExnduqxdJNKQrXrr1sxGxQeHxVHTtXFpLE5T8v1Wyyx+iML6oHTb4vCxCCNu1S681k4A0UJwkBL1AvHsjZaZttZ6Mlv5CMZ/ahigptT6ema4SzWtMQE2+SQ3B1YqSyI3WeYFEdM1MTM/TUxYZQUTfVSdK69dwv34R5JpoLVkMxVtz3tCCpaFVc+QpktFKK1wxEbdzhizRe2eGeDLbbtcUQigGjNSKK82Y22KeevSCXXRsimSLSiOh6b+nqEoTW9hHvILDubr/GT2OEg8vQjdXHiIbrYZ3guKwKNv6DRu6hw1T5BohkqqnQuiej/kSnvh2xYDNt2O+LlDyzx/GpL7AbxJNoftEQDhu72t0y7/aTXU3vv8l+Lsl/RPNgQyQV6XXKWlcknN4OhaNp4TVx6YkJM3lcKHvMXl+AR3a/lQaZuw3b/CbFXoxTnHGeI2ZN18eeXs+LDTTYcAbtLxA6j1zXMEmmRwtmfd1+Jtld2Y265vfVoKRNLoflRBezKlUR+e5ImrjytTgyrzw3RXRfVThEC7Ll7oI/e+0JGvL0+n2TMpfCnpR0nO3fZjU1lPXVRvhZty+tlTr/vKjSH5aljNXHFaQnRlFTkdgHTyw4xI1bEjNjxuCug47gYA+uucxF3yiK45db0TNhyz7RNToVygdOARnguXnKCIYY3SHcK4l1T294R4HSN+gqxI4bE0gvEmFi33Lp7pncuyrYsgqVjno3Oi6G5uyQZtLyTDzXE1HFohTG630YBYyBl3dEP2BFDYtkVgDGxlo52dte5CDvRCU45miPld3Hv7cqGPI9oAMEz8SiIv3BdEmonDALEjhgSS1/fgYoDaz4wF8A+TDp+mcgRmo32cch+hm11v72GBZsOrXkc5rieOdCfidoPhwCxI4bE0t9Rclg7M3LYh0vLk4pMsGbLybAzj/BrzjRozEChaONVoTIEiCGxJKZdwVW2jBHEvutcyJ3IlEjH2V/q0AR8QYeqPwHGfN+o7buqdqMgQAyJJTH1B2JO7P3nwuxHJtiRzkh/wmxoBlIZjjmvv9H5ZdR+eASIIbEkpoV4FmIfJtXIBEtHFLQtmP5ohqPJpLBEYUqgZPIRAIbEkpgWhiDsC2UKjyMTXJiAOo43AorgePNTcekUwRVDGO8EFMHx5qfi0imCK4Yw3gn4ViDjW1AqlFwopxHAVS7xj6Y8GgNo/fGb9apZC2qyzLNLq0V++HPz5HyV+3EPsSaYwHK9tANW0Y1fO2ITXF13tuWI5Vrz2JHSNQpw3sgVmWqZSUkq56G7sVi2Ed6XW3bCUR77LM/IRiHGwwV33F5S1MO/jIsEeVanmDEeW4Lp3bALjiKvrrXEsg8t8QWAJtEemMDa9YAYM0KKo+EVQSP9eNhxuZJVbs9imgnkuwl+Uy+uscSbn1jiq12O643ipUmSSez+sDa1TNPFd6bnFgfi5LHib2OxJJjkvvWpLR5emhWfbYNlBb2Jv0K/JVZkyzeO+MdKU7wC/6azZuvitMMNdxj3GoK/sr3tkziGZ1eZSM8S21tzflLM1+9KQxkuBKzbaov/bbbFi++b4oK5CTHrQC1WbkksJwOKH69AEp9bZYk7ns2I9V/l+g3/0+WUw3BhIAHsUa3wlLz/P6br38Sh2iOsUD7omLKMQ9+o+18xxdfwduT9l+f8o4YXl9fo9koX4I3bHXHHMxk0DCuwAXpxBmobqx7MnrL4fUv89dWsCy57xRlH5DwyN6An/+ttU3wK0gt7FMEjSfS3XvQe3t6O/Uvg8Bd2rCZhDyDPhe9abtonwQv0eAy99VhTee8zW/wT5O1qd9z7ciFRJJqjBeOT8PmH6rHqybEhmEB9vNURDy3JuorL94/SxQ0/qOsic+7BQpx+uC5++XhGvPe53WNvYW9eCJIn76eFAttrVIzD0eNq+EadC29HL3wH99kTQPgvHs2InRi2PbdX7zq37miBkYRlnzRGcz1J/eu5ftn+3o/NEM1pxxOvZV3FihoqgS7sqaPhQH/1qQmXCE/pCQKMw/ZTb+SG2t6Gal7jcExZDsfHTNHyyPXSnjlBExe1GPkOcd7Fzi3TaoXfP+sQp2XTWBDM3kuF5V0Mh+wh9GgY1QTEAsI0+C1RW+4NRBK8FVMbat9BipmXLK9RhrLUzOij3FOYPVlzh+zeGhYbJOvAurBOcQixIJj3zJWf2O69K5jW6FCR5DfW2a5y1lNsKm6UoWy1AqdLrAvrFIdQxaqVXx0C/dGWHNBs+Wvh5b8D97ug8CF6B+epQfdCvzxJo2GEQ3CQLM/xGmUom2tkmP/0EEhaR6bTktaDDE8zLdaFdYpDQHEGNvDe1YYpzvZOInj8JYwLd7+QLdJGKXP3wpwSVqqDUDNuAyFuugHCzIfXKENZDq9vgMTHXitmZs1GWzy4zOx1uPdQZMPJpYuGFZCvJ9df2251sb9yDMiHfsB+X2CC/dw7ltj0TTr0NCkgWfc+3d5DryP2vGZDudI675fsxfegYVFLDztNCsrXrQ/bCZ5YGOgQC4IJbGFrJ8nvQGFZhed12Cuo5XL45vmwwTVI9DJG0d5MGS9wn7+FmIvzx0uc4zJPyoYNrEtc7sER4ApbvWhyvNM21En3QTUuJOSWi3JpuBpwZ+/qTRsOypHp0q48Ek/xBZkteW4ErlGGjYdkeoEGk3IDV7a4EMI6sQwDHSK0y74pKgHh29hpvCfQ1QocekdjqsXnknsieAyuUYay1QqsA+vCOvXVMmaUsg44wSwsh8Uj8QaAagZakmbAQDG84DEQLw+Cz2uUqbbViXXxD/1engOxrS6qZdaAAPOZ4rGwYFWjF3NoxHefXUUpqPd6xeQ1KlOUZZxKA8vOOrAu1W405ZYtFgQTaFquzjzKCFwxilo5fvS7+SBdTC/RO0kCZSjLOJUGrnaxDqxLbw2r0nyixI8FwSwwLUBctD92iuYu0UWphF+WHhYTRktx3hwj1D2QQzVlGSfv4Wt/oiH2uazIsrMOcVr8jw3BHCJpBbrspIQ4FG/jIWBRA4Gl0nQFFiSoXIUZ7ilDWcZh3HLIYVlZZpaddajGcB+17j3Jx4ZgFpBgj8DbAa49MyHm4d5IsMPcy6gFE+SDsER4HZYYD+ZD6OjJYQNlGYdxmQbTCqNZs2wsI8vKMrPsYRpV2HJVQ66CGV81si9Og/exYXidwZXoUVRWnoELDRf7LYBJg4dnEOHQyndPcf5Kv6yTMDSefoThvu+inF7IOJPGSHHjD+vEv98xXZ8s+mO5Iwsy8bRi3ltJPp/+mwj57+Ge23Kw7l4P8jgprmH/nokdwaw+ewGJO36G7i7h/ReLD/Ss+ByOd7vhWUFy+VIzrhsfAiXpsAM0sTfWitkTo/TcQqgZlw4DZx9ruA2GJssPYIfeDL8vvjyNJPP9IwdgnnvYtzT3Od5GvmwGjSMuSlVhnWJJMAvJnsNeRUsTe/LRcN9hDyEJJJhmS8+6xaGyWqs3JIppcbhlA+OPeTIPEsw8abakHMtTzmhRSEJfHseWYK/SJNPfK10bL4Dm+b4ElwT60/ds0Rxd4naf9bAK2sae4MJCA/cBCQOVb6WVjZUWXWllVPxiBBTBxZjU1BlFcE3RWVwZRXAxJjV1RhE8mOiUemRdLzLBtqbR76Ir0CDBaUMH5o6etafrotqJjAAxpKnUM/b4E7Clk/9ibv/FHvYjE4wPwmzFh3/ykqMRYBvMeorgPFjKOiCGfBs8Mc0LwNzFPu9k6YPIBGu6XI/vCeR9j4bjxsd4nFIRXBrwUhLEkFjmjcU4ScyJfan4hdcjE9yWqVsPM9LnUnZ6wyFFWnn4oYndGEAUyYUQhz8mdsSQWHqWM8Z2sQbmLvbhk3MlIxP8VkryHrxc6rDKdwaugX6B52RXb8Djl928e5fVNiQCxI4YEkti6oVOrJd3Yu+dDrX1JRNK3hVyHOdJ/9tmeRKNTzyN53f5hJ23pOcKq3+hECBmxI4YEsu8gLfNupjnnQx3UBbBaadxEb6R9KG/F3N1Zx2e7+XrFLgCpEI0BIgZsSOGxNILxJhYE3PvXJRtWQTnhgrtLg0fWPQHFvJpLNDzKXuuqxa1RL+w2ncRIEbEipgRu8LOkcNYu6uc4ZkZlEUwI9rDkg9Y+HATv9LlBY/Q+1/JYqix3Jbov5d4cmqbQ4DYsLcSK2LG4GHIfWJLjIk1j8sJ/vQix29O7ZqjJxoWQ4dvcJzuiRvXajlRn4vXH9A7Yjw8FnnMH68N5UBNmcTytwnK1BOvm2IpHkLnsX8G4mrOmtaO1/mfvPzmxhXlYlYRwcx0zm1tV+p6/T34LGoRe1ww5xe+WqbB93iq7j7SQRcXKhQVZ1xujQcoHts1nQjaABPf+bXiI77/yxbftAW8VAZMazp6r9Vx1fKbGu+tpMhVwbnl1rbf4Ft717kfp4TG5w+sFD0y+EDXvnCOo+c/HwjjPG+odGaCTPeenSCT7/Xi8890C6L7T9GMA187cz9OmW3/7bKbG6/3Y1nOflUIZsZzF7SmhFF3C8dg92vfAaXhEE3COUwPFXI9GAg0h2ASyuE4KPCr4K6QmVmw9JamVJBM1HNVI5gZtyzYc77Uk3/UDGM/ix+IHuo33LBsgHkd3w22TXOrY6WvXXbLsEfCRi0lV1WCmdmc2zqm6FJbgH58Dr4UYjhmBjx3K2ClCjSUrlORkkYdPgidMbGQ8Di+8X7L8pvq11UTg6oT7BWu+fa2ObpjXI5B+QwQvY/E2OR+wct9M4TIDT+d8c2/y6lQZ4G+InVf7s2U7gq+3O2cWkcrE/2fW7qPqQnK5jZz/wJRm7lO1wb/8AAAAASUVORK5CYII=';
const SECTIONS = ACCOUNT_APP_CONFIG.nav || [
  { key: 'how-to',           icon: ROBOTDOJO_LOGO_ICON, label: 'How To Robot' },
  { key: 'general',          icon: 'admin_panel_settings', label: 'Admin' },
  { key: 'integrations',     icon: 'electrical_services', label: 'Integrations' },
  { divider: true },
  { key: 'agents',           icon: 'smart_toy',           label: 'Agents' },
  { key: 'skills',           icon: 'construction',        label: 'Skills' },
  { key: 'you',              icon: 'person',              label: 'You' },
  { divider: true },
  { key: 'shortcuts',        icon: 'keyboard',            label: 'Shortcuts' },
];
const HIDDEN_ROUTABLE_SECTIONS = new Set(['imports']);

const INTEGRATION_FILTERS = [
  { key: 'llm', icon: 'smart_toy', label: 'LLM Providers' },
  { key: 'email', icon: 'mail', label: 'Email' },
  { key: 'calendar', icon: 'calendar_month', label: 'Calendar' },
  { key: 'task', icon: 'task_alt', label: 'Tasks' },
  { key: 'sms', icon: 'sms', label: 'SMS' },
  { key: 'database', icon: 'database', label: 'Database' },
  { key: 'domains', icon: 'language', label: 'Domains' },
  { key: 'other', icon: 'extension', label: 'Other' },
];

// Category mapping for connected accounts (Phase 4b).
// Drives the grouping shown in the Integrations tab.
const VENDOR_CATEGORY = {
  openai: 'llm', anthropic: 'llm', xai: 'llm',
  google: 'workspace', microsoft: 'workspace', notion: 'workspace', asana: 'workspace',
  oura: 'health', granola: 'health',
  stripe: 'tools', neon: 'tools', lob: 'tools',
  twilio: 'tools', instantly: 'tools', iproyal: 'tools', elevenlabs: 'tools', godaddy: 'tools',
};

const CATEGORY_LABELS = {
  workspace: 'Workspace',
  mac:       'Mac',
  health:    'Health',
  tools:     'Tools',
  other:     'Other',
};

// Render order for category groups in the Integrations view.
const CATEGORY_ORDER = ['workspace', 'health', 'tools', 'other'];

// Icons per identity section slug. Defaults only — unknown slugs (including
// any user-defined custom card such as a personal virtues framework) fall back
// to `bookmark`. WHY no user-specific entries here: keep the public source
// generic; per-user icon overrides belong in taxonomy.user.json.
const IDENTITY_SECTION_ICONS = {
  identity:   'badge',
  soul:       'self_improvement',
  philosophy: 'lightbulb',
  style:      'record_voice_over',
  user:       'person',
  agents:     'smart_toy',
};

const AGENT_SHOWCASE_COPY = {
  Miyagi: [
    'Miyagi is the default persona: the one that hears the request and decides what kind of work it really is.',
    'He keeps conversation, research, design, build, and proof in the right order.',
    'The point is not more process. The point is judgment that compounds.',
  ],
  Tantei: [
    'Tantei enters when the codebase has to be mapped before anyone earns an opinion.',
    'He reads the terrain: files, imports, state, contracts, and the places a small change can break something large.',
    'That is how Robot Dojo avoids confident edits against an imaginary system.',
  ],
  Hakase: [
    'Hakase is the outside-memory layer.',
    'When the repo is not enough, he brings in prior art, known failures, and patterns that survived contact with production.',
    'The product gets sharper because it is not trapped inside its own source tree.',
  ],
  Ori: [
    'Ori is where an idea becomes shape.',
    'Schemas, APIs, phases, data flow: the parts that have to be right before code starts moving.',
    'Good architecture feels quiet later. That is the point.',
  ],
  Katagami: [
    'Katagami is the build hand.',
    'He gets the sealed plan and turns it into working behavior, with tests and evidence instead of theater.',
    'This is where Robot Dojo stops discussing the product and changes it.',
  ],
  Bunshin: [
    'Bunshin is the split-self auditor.',
    'He reads the work cold and asks what is fake, skipped, weak, or being pushed back onto the user.',
    'Quality rises because the critique happens before the owner has to supply it.',
  ],
};

const AGENT_SHOWCASE_ROLE = {
  Miyagi: 'Orchestrator',
  Tantei: 'Mapper',
  Hakase: 'Researcher',
  Ori: 'Architect',
  Katagami: 'Builder',
  Bunshin: 'Auditor',
};

const SKILL_SHOWCASE_COPY = {
  goal: [
    'Goal is the top-level intake: the user names the outcome, and Robot Dojo chooses the right tracked path.',
    'It routes plain-language goals into defect, story, or work instead of creating a parallel process.',
    'That gives the user Codex-style momentum while preserving Robot Dojo quality gates, artifacts, and traceability.',
  ],
  story: [
    'Story is how a new product improvement enters Robot Dojo without becoming a vague todo.',
    'It captures the original request, creates the work record, and moves immediately into framing so the user value is named before execution begins.',
    'It makes ambition trackable: every meaningful enhancement gets a place, a reason, and a first gate.',
  ],
  defect: [
    'Defect is the path for broken promises: something used to work, or should work, and now needs correction.',
    'It records the symptom without pretending to know the cause, then routes into framing so the repair is anchored in visible behavior.',
    'It keeps bugs from becoming folklore by turning each failure into a concrete, auditable work item.',
  ],
  work: [
    'Work opens a topic in the coding agent: last state, log, and next step.',
    'It loads that topic at the start and writes durable synthesis back at the end, so the next session resumes instead of disappearing into chat history.',
    'It is the bridge between conversation and long-lived intelligence: sessions become memory the next session can actually use.',
  ],
  framing: [
    'Framing is the first taste gate: it translates a request into the human outcome the product must protect.',
    'It strips away implementation noise until the story says what the user should be able to do, trust, avoid, or understand.',
    'That is why later stages stay honest: scope and build are judged against value, not just activity.',
  ],
  research: [
    'Research slows the system down exactly where speed would become expensive.',
    'Tantei maps the codebase, Hakase brings external evidence when needed, and Miyagi turns both into a recommendation.',
    'It gives Robot Dojo informed motion: enough source truth to build once instead of thrashing through rework.',
  ],
  scope: [
    'Scope turns the approved direction into acceptance criteria the user can recognize.',
    'It names what is in, what is out, and what must be true before the work counts as done.',
    'It is the contract that keeps a beautiful idea from becoming a blurry implementation sprint.',
  ],
  plan: [
    'Plan turns approved scope into the build path.',
    'It specifies files, data flow, verification criteria, and the failure cases that must not be hand-waved.',
    'It is where Robot Dojo earns the right to build once instead of improvising inside the codebase.',
  ],
  build: [
    'Build is where approved plans become real product behavior through Katagami.',
    'It keeps implementation bounded by scope, produces runnable verification criteria, and stops before QA so construction and certification stay separate.',
    'It is the platform taking itself seriously: no performative progress, only working code and evidence.',
  ],
  qa: [
    'QA is the certification gate for shipped behavior, not a rubber stamp after tests happen to pass.',
    'It checks the build against scope, plan, criteria, and real user-facing flows when the surface demands it.',
    'It protects trust in Robot Dojo by making done mean proven, not merely merged.',
  ],
  close: [
    'Close is the formal wrap after QA passes.',
    'It records what shipped, ties the proof back to the original goal, and moves the tracked record to done.',
    'It keeps completion from becoming vibes: the story ends only after the evidence is attached.',
  ],
};

const YOU_SHOWCASE_COPY = [
  'This is where Robot Dojo stores the durable version of how to understand you: how you think, write, work, decide, and prefer to be helped.',
  'It lets chat start from your actual context instead of asking you to re-explain yourself every session.',
  'The better this source gets, the more the whole system feels like it is working with you, not merely answering you.',
];

// st_4e7e3aaf AC5 — stale-while-revalidate persisted client cache.
// Tunable revalidation cadence; lives at file-top so reviewers can find it.
const SECTION_REVALIDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const _SECTION_CACHE_PREFIX = 'rd_acct_cache_';
const _SECTION_CACHE_VERSION = { 'edit-targets': 2 };
const INTEGRATION_ORDER_STORAGE_KEY = 'rd_integration_order_v1';
const PROVIDER_SORTABLE_INTEGRATION_SECTIONS = new Set(['foundation_models', 'productivity']);
const ACCOUNT_SORTABLE_INTEGRATION_SECTIONS = new Set(['workspace', 'productivity']);

// Sections written to localStorage for fast repeat loads. Empty-cache
// integrations deep-links are seeded from /api/accounts/app-state before the
// first render when possible, then normal tab fetches/revalidation take over.
const _WARMED_SECTIONS = ['integrations', 'edit-targets', 'agent-personas', 'general', 'setup', 'imports'];
const _APP_STATE_WARMED_SECTIONS = new Set(['edit-targets', 'general', 'setup', 'imports']);
let pendingIntegrationKeyProvider = '';
const MEMORY_PROMPT_COLLAPSED_STORAGE_KEY = 'rd_memory_prompt_collapsed';
const MEMORY_PROMPT_CACHE_KEY = 'rd_memory_prompt_cache';
const PROFILE_SEED_CHAT_CONTEXT = 'canonical-profile-seed';
let _memoryPromptText = '';
let _memoryPromptHash = '';
let _memoryPromptLoadPromise = null;

function _readMemoryPromptCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_PROMPT_CACHE_KEY) || '');
    if (parsed?.text && String(parsed.text).length >= 800) return parsed;
  } catch { /* */ }
  return null;
}

function _writeMemoryPromptCache(text, hash) {
  try {
    localStorage.setItem(MEMORY_PROMPT_CACHE_KEY, JSON.stringify({ text, hash: hash || '' }));
  } catch { /* quota / disabled */ }
}

(function _hydrateMemoryPromptCache() {
  const cached = _readMemoryPromptCache();
  if (!cached) return;
  _memoryPromptText = cached.text;
  _memoryPromptHash = cached.hash || '';
})();

function _readSectionCache(key) {
  try {
    const raw = localStorage.getItem(_SECTION_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const expectedVersion = _SECTION_CACHE_VERSION[key] || 0;
    if (expectedVersion && parsed?.version !== expectedVersion) return null;
    return parsed?.payload ?? null;
  } catch {
    return null;
  }
}

function _writeSectionCache(key, payload) {
  try {
    // Section payloads are plain JSON shipped from server endpoints; no
    // functions, no DOM refs. JSON.stringify is safe here.
    const expectedVersion = _SECTION_CACHE_VERSION[key] || 0;
    const envelope = expectedVersion
      ? { payload, ts: Date.now(), version: expectedVersion }
      : { payload, ts: Date.now() };
    localStorage.setItem(_SECTION_CACHE_PREFIX + key, JSON.stringify(envelope));
  } catch { /* localStorage quota / disabled — non-fatal */ }
}

function _clearSectionCache(key) {
  try { localStorage.removeItem(_SECTION_CACHE_PREFIX + key); } catch { /* */ }
}

// Background revalidation hooks — called from the hourly timer and on
// invalidate-on-mutation paths. Each section knows how to fetch + re-render.
async function revalidateSectionInBackground(key) {
  let url = null;
  if (key === 'integrations') url = '/api/accounts/integration-cards?refresh=1';
  else if (key === 'edit-targets') url = '/api/accounts/edit-targets';
  else if (key === 'agent-personas') url = '/api/accounts/agent-personas';
  else if (key === 'setup') url = '/api/setup/progress';
  else if (key === 'imports') url = '/api/accounts/imports';
  if (!url) return;
  const fresh = await _silentFetchJSON(url);
  if (!fresh) return;
  const cached = _readSectionCache(key);
  if (JSON.stringify(cached) === JSON.stringify(fresh)) return;
  _writeSectionCache(key, fresh);
  if (key === 'integrations' && activeSection === 'integrations') {
    _integrationCards = fresh;
    updateSidebarCounts();
    renderIntegrations();
  } else if (key === 'agent-personas' && activeSection === 'agents') {
    _renderAgentsFromData(fresh);
  } else if (key === 'edit-targets' && activeSection === 'skills') {
    _renderEditTargetListFromData('skills', 'Skills', 'construction', fresh);
  } else if (key === 'edit-targets' && activeSection === 'you') {
    _renderEditTargetListFromData('you', 'You', 'person', fresh);
  } else if (key === 'setup' && activeSection === 'setup') {
    _setupProgress = fresh;
    renderSetup();
  } else if (key === 'imports' && activeSection === 'imports') {
    renderImports();
  }
}

let allAccounts = [], allVendors = {}, llmProviders = [], secretsStatus = { secrets: {}, vendorSecrets: {} };
let activeSection = 'how-to';
let _renderCycle = 0;
let _setupProgress = null;         // { completeness_pct, total_steps, completed_steps, steps[] }
let _adminStatus = { is_admin: false, belt_override: null };
let _expandedSetupCard = null;     // step.id currently expanded for inline editing
// name → { status, last_sync, last_check, error } from /api/integrations/health
let _integrationHealth = {};
let _deviceSlug = null;
let _referralCandidates = [];      // pre-loaded at init from /api/referral-candidates
// Integration cards data from /api/accounts/integration-cards
let _integrationCards = null;      // { sections: [...], connected: N, total: M }
let _integrationSortables = [];
const tabDataLoaded = {};   // { integrations: true, referrals: true, setup: true }
const accountAppState = window.RobotDojoAppState ? new window.RobotDojoAppState() : null;
let _initialAccountState = null;
let _initialAccountStatePromise = null;

function appComponents() { return window.RobotDojoComponents || {}; }
function markAccountReady() {
  if (appComponents().setAppReady) appComponents().setAppReady();
  else document.body.classList.add('app-ready');
}

function loadAccountTabState(key, fetcher, options) {
  const force = options?.force === true;
  if (!force && accountAppState?.tabs?.has(key)) {
    return Promise.resolve(accountAppState.tabs.get(key));
  }
  if (!force && _APP_STATE_WARMED_SECTIONS.has(key)) {
    const cached = _readSectionCache(key);
    if (cached) {
      if (accountAppState) {
        accountAppState.tabs.set(key, cached);
        accountAppState.timestamps.set(key, { loadedAt: Date.now(), durationMs: 0, source: 'warm-cache' });
      }
      Promise.resolve().then(async () => {
        const fresh = await fetcher();
        if (fresh == null) return;
        _writeSectionCache(key, fresh);
        if (accountAppState) {
          accountAppState.tabs.set(key, fresh);
          accountAppState.timestamps.set(key, { loadedAt: Date.now(), durationMs: 0, source: 'revalidate' });
        }
      }).catch(() => { /* warm-cache revalidation is optional */ });
      return Promise.resolve(cached);
    }
  }
  if (!accountAppState) return fetcher();
  return accountAppState.loadTab(key, async () => {
    const payload = await fetcher();
    if (_APP_STATE_WARMED_SECTIONS.has(key) && payload != null) _writeSectionCache(key, payload);
    return payload;
  }, options);
}

function _applyInitialAccountState(state) {
  if (!state) return;
  _initialAccountState = state;

  const integrationPayload = state.integrations?.payload;
  if (integrationPayload && Array.isArray(integrationPayload.sections)) {
    _integrationCards = integrationPayload;
    tabDataLoaded.integrations = true;
    _writeSectionCache('integrations', integrationPayload);
    if (accountAppState) {
      accountAppState.tabs.set('integrations', integrationPayload);
      accountAppState.timestamps.set('integrations', { loadedAt: Date.now(), durationMs: 0, source: 'app-state' });
    }
  }
}

async function loadInitialAccountState({ includeIntegrations = false } = {}) {
  const url = `/api/accounts/app-state${includeIntegrations ? '?include=integrations' : ''}`;
  const load = async () => {
    const state = await _silentFetchJSON(url);
    _applyInitialAccountState(state);
    return state;
  };
  if (!accountAppState) return load();
  if (accountAppState.initial) {
    _applyInitialAccountState(accountAppState.initial);
    return accountAppState.initial;
  }
  return accountAppState.loadInitial(load);
}

function invalidateAccountTabState(key) {
  if (accountAppState) accountAppState.invalidate(key);
  // st_4e7e3aaf AC5 — persisted cache must never be staler than the last
  // local mutation. Clear the matching localStorage key whenever the
  // in-memory tab-state cache is invalidated.
  if (key === 'general') _clearSectionCache('general');
  if (key === 'edit-targets') _clearSectionCache('edit-targets');
  if (key === 'agent-personas') _clearSectionCache('agent-personas');
}

function invalidateIntegrationsState() {
  invalidateAccountTabState('integrations');
  tabDataLoaded.integrations = false;
  // st_4e7e3aaf AC5 — invalidate-on-mutation for the persisted integrations
  // cache. Every caller of this function has just mutated server state
  // (added/removed/edited a key or account), so the local cache is stale.
  _clearSectionCache('integrations');
}

function _readIntegrationOrderPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INTEGRATION_ORDER_STORAGE_KEY) || '{}');
    return {
      sections: parsed && typeof parsed.sections === 'object' ? parsed.sections : {},
      accounts: parsed && typeof parsed.accounts === 'object' ? parsed.accounts : {},
    };
  } catch {
    return { sections: {}, accounts: {} };
  }
}

function _writeIntegrationOrderPrefs(prefs) {
  try {
    localStorage.setItem(INTEGRATION_ORDER_STORAGE_KEY, JSON.stringify({
      sections: prefs.sections || {},
      accounts: prefs.accounts || {},
    }));
  } catch { /* localStorage quota / disabled — non-fatal */ }
}

function _mergeSavedOrder(previous = [], current = []) {
  const seen = new Set(current);
  return [...current, ...previous.filter((key) => !seen.has(key))];
}

function _saveIntegrationOrder(scope, order, kind = 'sections') {
  if (!scope || !Array.isArray(order) || !order.length) return;
  const prefs = _readIntegrationOrderPrefs();
  const bucket = kind === 'accounts' ? prefs.accounts : prefs.sections;
  bucket[scope] = _mergeSavedOrder(bucket[scope] || [], order);
  _writeIntegrationOrderPrefs(prefs);
}

function _sortBySavedOrder(items, savedOrder, keyFn) {
  if (!Array.isArray(items) || !items.length || !Array.isArray(savedOrder) || !savedOrder.length) return items;
  const index = new Map(savedOrder.map((key, i) => [String(key), i]));
  return items
    .map((item, originalIndex) => ({ item, originalIndex, key: String(keyFn(item) || '') }))
    .sort((a, b) => {
      const ai = index.has(a.key) ? index.get(a.key) : Number.POSITIVE_INFINITY;
      const bi = index.has(b.key) ? index.get(b.key) : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ item }) => item);
}

function _integrationProviderSortKey(card) {
  return String(card?.provider || card?.name || '').toLowerCase();
}

function _integrationAccountSortKey(acct) {
  return String(acct?.email || acct?.label || acct?.name || acct?.account_key || 'account')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function _orderedIntegrationSection(section) {
  const prefs = _readIntegrationOrderPrefs();
  let cards = (section.cards || []).map((card) => ({
    ...card,
    accounts: Array.isArray(card.accounts) ? card.accounts.slice() : card.accounts,
  }));

  if (PROVIDER_SORTABLE_INTEGRATION_SECTIONS.has(section.id)) {
    cards = _sortBySavedOrder(cards, prefs.sections[section.id] || [], _integrationProviderSortKey);
  }

  if (ACCOUNT_SORTABLE_INTEGRATION_SECTIONS.has(section.id)) {
    cards = cards.map((card) => {
      if (!Array.isArray(card.accounts) || card.accounts.length < 2) return card;
      const scope = `${section.id}:${_integrationProviderSortKey(card)}`;
      return {
        ...card,
        accounts: _sortBySavedOrder(card.accounts, prefs.accounts[scope] || [], _integrationAccountSortKey),
      };
    });
  }

  return { ...section, cards };
}

function _destroyIntegrationSortables() {
  for (const sortable of _integrationSortables) {
    try { sortable.destroy(); } catch { /* optional cleanup */ }
  }
  _integrationSortables = [];
}

function _initIntegrationSortables() {
  _destroyIntegrationSortables();
  if (typeof Sortable === 'undefined') return;

  for (const groupId of PROVIDER_SORTABLE_INTEGRATION_SECTIONS) {
    const table = document.querySelector(`[data-integration-group="${groupId}"] table`);
    if (!table || table.querySelectorAll('tbody.integ-sort-provider-block').length < 2) continue;
    _integrationSortables.push(new Sortable(table, {
      animation: 150,
      handle: '.integ-provider-drag-handle',
      draggable: 'tbody.integ-sort-provider-block',
      ghostClass: 'integ-sort-ghost',
      chosenClass: 'integ-sort-chosen',
      onEnd: () => {
        const order = [...table.querySelectorAll('tbody.integ-sort-provider-block')]
          .map((el) => el.dataset.sortKey)
          .filter(Boolean);
        _saveIntegrationOrder(groupId, order, 'sections');
      },
    }));
  }

  for (const body of document.querySelectorAll('tbody[data-account-sort-scope]')) {
    if (body.querySelectorAll('tr.integ-sort-account').length < 2) continue;
    _integrationSortables.push(new Sortable(body, {
      animation: 150,
      handle: '.integ-account-drag-handle',
      draggable: 'tr.integ-sort-account',
      ghostClass: 'integ-sort-ghost',
      chosenClass: 'integ-sort-chosen',
      onEnd: () => {
        const order = [...body.querySelectorAll('tr.integ-sort-account')]
          .map((row) => row.dataset.sortKey)
          .filter(Boolean);
        _saveIntegrationOrder(body.dataset.accountSortScope, order, 'accounts');
      },
    }));
  }
}

function normalizeSectionKey(key) {
  const raw = String(key || '').replace(/^#/, '') || 'how-to';
  if (raw.startsWith('workbenches/')) return 'how-to';
  if (/^(feature-requests?|referrals|invite|reporting)$/.test(raw)) return 'how-to';
  return ACCOUNT_ALIASES[raw] || raw;
}

function isRoutableSection(key) {
  return SECTIONS.some(s => s.key === key) || HIDDEN_ROUTABLE_SECTIONS.has(key);
}

function isStaleRender(cycle) {
  return cycle !== _renderCycle;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // st_01b16272 AC 2 — accounts has no search box; hideSearch skips the
  // shared #persistentSearchInput markup entirely rather than hiding it.
  if (initShell({ hideSearch: true, hideSync: true, sidebarFooter: false }) === false) return;

  // WHY: pathname takes precedence; hash fallback supports old bookmarks.
  const initialQueryParams = new URLSearchParams(location.search);
  pendingIntegrationKeyProvider = initialQueryParams.get('action') === 'key'
    ? String(initialQueryParams.get('provider') || '').trim().toLowerCase()
    : '';
  const pathTab = location.pathname.replace(/^\/accounts?\/?/, '');
  const hashTab = location.hash.slice(1);
  const initialTab = normalizeSectionKey(pathTab || hashTab || 'how-to');
  if (isRoutableSection(initialTab)) activeSection = initialTab;

  // Normalize URL to pathname form on first load (no history entry pollution).
  const canonicalPath = '/account/' + activeSection;
  history.replaceState({ tab: activeSection }, '', canonicalPath);

  ensureMemoryPromptText().catch(() => {});

  const initialStatePromise = loadInitialAccountState();
  _initialAccountStatePromise = initialStatePromise;
  initialStatePromise.catch(() => { /* optional first-load metadata */ });

  buildSidebar();
  markAccountReady();
  // WHY: render immediately without loading all 8 endpoints — each tab
  // fetches only its own data on first activation (lazy loading).
  renderSection();

  // Admin status is optional chrome metadata. Hydrate it only on admin/setup
  // surfaces so unrelated Account tabs never inherit a transient status probe.
  if (activeSection === 'admin' || activeSection === 'setup') _silentFetchJSON('/api/setup/admin/status', { timeoutMs: 4000 })
    .then((data) => {
      if (!data) return;
      _adminStatus = data;
      buildSidebar();
      if (activeSection === 'admin' || activeSection === 'setup') renderSection();
    })
    .catch(() => { /* non-fatal */ });

  // st_4e7e3aaf AC5 — hourly background revalidation. Each warmed section
  // refreshes from the server and re-renders only if the payload differs.
  setInterval(() => {
    for (const key of _WARMED_SECTIONS) {
      revalidateSectionInBackground(key).catch(() => { /* non-fatal */ });
    }
  }, SECTION_REVALIDATE_INTERVAL_MS);
});

// WHY: popstate fires when the user navigates back/forward through pushState history entries.
window.addEventListener('popstate', (e) => {
  const tab = normalizeSectionKey(e.state?.tab || location.pathname.replace(/^\/accounts?\/?/, '') || 'how-to');
  if (isRoutableSection(tab) && tab !== activeSection) {
    activeSection = tab;
    $$('[data-section]').forEach(el => el.classList.toggle('active', el.dataset.section === tab));
    renderSection();
  }
});

// --- Data ---

// Silent JSON fetch for optional endpoints — no toast on 4xx/5xx.
async function _silentFetchJSON(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    const token = localStorage.getItem('robotdojo_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally {
    clearTimeout(timer);
  }
}

async function refreshSetup() {
  _setupProgress = await _silentFetchJSON('/api/setup/progress') || _setupProgress;
  tabDataLoaded.setup = true;
  updateSidebarCounts();
  if (activeSection === 'setup') renderSetup();
}

// --- Sidebar ---
function buildSidebar() {
  const container = $('#sidebarContent');
  // Filter out admin-only entries for non-admins. Divider entries (no `key`)
  // pass through because they have no `admin` property.
  const visible = SECTIONS.filter(s => !s.admin || _adminStatus.is_admin);

  // Footer items (Delete / Admin) are separated from main items. Dividers
  // placed after a footer item are intentionally included in the footer block,
  // but dividers with no adjacent nav items are emitted inline.
  const mainItems   = visible.filter(s => !s.footer);
  const footerItems = visible.filter(s => s.footer);

  const renderItem = (s) => {
    // Divider entry — emits an <hr> instead of a nav item.
    if (s.divider) return '<hr class="acct-nav-divider">';
    if (s.key === 'setup' && _setupProgress && _setupProgress.completeness_pct >= 100) return '';
    const isSetup = s.key === 'setup';
    const setupBadge = isSetup ? '<span class="acct-nav-badge" id="setupNavBadge"></span>' : '';
    const dangerCls = s.danger ? ' acct-nav-item-danger' : '';
    const adminCls  = s.admin ? ' acct-nav-item-admin' : '';
    return `<div class="acct-nav-item${s.key === activeSection ? ' active' : ''}${dangerCls}${adminCls}" data-section="${esc(s.key)}" onclick="setSection('${s.key}')">
      ${renderAccountNavIcon(s.icon)}
      <span class="acct-nav-name">${esc(s.label)}</span>
      ${setupBadge}
      <span class="acct-nav-count" id="navCount_${s.key}"></span>
    </div>`;
  };

  let html = '<div class="acct-nav rd-sidebar-section">';
  for (const s of mainItems) {
    html += renderItem(s);
  }
  if (footerItems.length) {
    html += '<div class="acct-nav-footer">';
    for (const s of footerItems) html += renderItem(s);
    html += '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
  updateSetupBadge();
}

function isImageIcon(icon) {
  return typeof icon === 'string' && (icon === ROBOTDOJO_LOGO_ICON || /^(data:image\/|\/|https?:\/\/)/.test(icon));
}

function resolveAccountAssetUrl(url) {
  if (typeof url !== 'string') return '';
  if (url === ROBOTDOJO_LOGO_ICON) return ROBOTDOJO_LOGO_DATA_URI;
  if (url.startsWith('data:image/')) return url;
  const proxyPrefix = location.hostname.match(/^([a-z0-9-]+)\.robotdojo\.ai$/)
    ? ''
    : (location.pathname.match(/^\/me\/[^/]+/) || [''])[0];
  if (proxyPrefix && url.startsWith('/static/')) return proxyPrefix + url;
  return url;
}

function renderAccountNavIcon(icon) {
  if (icon === ROBOTDOJO_LOGO_ICON) {
    return renderRobotDojoLogoIcon('acct-nav-icon acct-nav-image-icon');
  }
  if (isImageIcon(icon)) {
    return `<img class="acct-nav-icon acct-nav-image-icon" src="${esc(resolveAccountAssetUrl(icon))}" alt="" aria-hidden="true">`;
  }
  return `<span class="material-symbols-outlined acct-nav-icon">${esc(icon || 'settings')}</span>`;
}

function renderAccountCardIcon(icon) {
  if (icon === ROBOTDOJO_LOGO_ICON) {
    return renderRobotDojoLogoIcon('acct-card-image-icon');
  }
  if (isImageIcon(icon)) {
    return `<img class="acct-card-image-icon" src="${esc(resolveAccountAssetUrl(icon))}" alt="" aria-hidden="true">`;
  }
  return `<span class="material-symbols-outlined">${esc(icon || 'settings')}</span>`;
}

function renderRobotDojoLogoIcon(className) {
  return `<svg class="${className}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <rect x="8" y="16" width="48" height="36" rx="8" fill="#dbeafe" stroke="#3b82f6" stroke-width="3"/>
    <circle cx="24" cy="34" r="6" fill="#3b82f6"/>
    <circle cx="40" cy="34" r="6" fill="#3b82f6"/>
    <circle cx="22" cy="32" r="2" fill="#fff"/>
    <circle cx="38" cy="32" r="2" fill="#fff"/>
    <line x1="32" y1="16" x2="32" y2="6" stroke="#93c5fd" stroke-width="3" stroke-linecap="round"/>
    <circle cx="32" cy="4" r="4" fill="#60a5fa"/>
  </svg>`;
}

function howtoKey(text) {
  return `<strong class="howto-key">${esc(text)}</strong>`;
}

function updateSetupBadge() {
  const badge = $('#setupNavBadge');
  if (!badge) return;
  if (!_setupProgress) { badge.textContent = ''; badge.classList.remove('acct-nav-badge-on'); return; }
  const pct = _setupProgress.completeness_pct || 0;
  if (pct >= 100) { badge.textContent = ''; badge.classList.remove('acct-nav-badge-on'); return; }
  badge.textContent = `${pct}%`;
  badge.classList.add('acct-nav-badge-on');
}

function updateSidebarCounts() {
  const el = $('#navCount_integrations');
  if (el) {
    // If integration cards loaded, show "connected/total" from the new aggregated view.
    // Fall back to old logic if the endpoint hasn't responded yet.
    if (_integrationCards && typeof _integrationCards.connected === 'number') {
      el.textContent = `${_integrationCards.connected}/${_integrationCards.total}`;
    } else {
      const llmActive = llmProviders.filter(p => p.active).length;
      el.textContent = (allAccounts.length + llmActive) || '';
    }
  }
  updateSetupBadge();
}

function setSection(key) {
  activeSection = normalizeSectionKey(key);
  // WHY: pushState creates a history entry so browser Back/Forward work.
  // replaceState would update the URL but not allow Back navigation between tabs.
  history.pushState({ tab: activeSection }, '', '/account/' + activeSection);
  $$('[data-section]').forEach(el => el.classList.toggle('active', el.dataset.section === activeSection));
  // st_4e7e3aaf AC5 — section-switch timing. The renderer fires synchronously
  // from cache when warm; this measurement is the headline "<=100ms" signal.
  const _t0 = performance.now();
  renderSection();
  window.__sectionSwitchMs = performance.now() - _t0;
  console.log(`[section-switch] ${activeSection} ${window.__sectionSwitchMs.toFixed(1)}ms`);
  if (typeof isMobile === 'function' && isMobile() && typeof toggleSidebar === 'function') {
    toggleSidebar(false);
  }
}

function renderSection() {
  if (activeSection !== 'integrations') _destroyIntegrationSortables();
  const renderCycle = ++_renderCycle;
  // Removed keys (assistants, assistant, foundation, identity, user,
  // topics, releases, usage, appearance, preferences) no longer appear in
  // SECTIONS, so they cannot be selected through normal navigation.
  const renderers = {
    setup:            renderSetup,
    'how-to':         renderHowTo,
    general:          renderGeneral,
    agents:           renderAgents,
    you:              renderYou,
    skills:           renderSkills,
    shortcuts:        renderShortcuts,
    integrations:     renderIntegrations,
    imports:          renderImports,
    'remote-access':  renderGeneral,
    usage:            renderIntegrations,
    reporting:        renderHowTo,
    'feature-request':  renderHowTo,
    'feature-requests': renderHowTo,
    referrals:        renderHowTo,
    invite:           renderHowTo,
    delete:           renderGeneral,
    admin:            renderAdmin,
  };
  const result = (renderers[activeSection] || renderGeneral)(renderCycle);
  if (result && typeof result.catch === 'function') {
    result.catch((err) => {
      if (!isStaleRender(renderCycle)) console.error(err);
    });
  }
}

// ===== Setup =====
const STEP_DURATIONS = {
  'device-name':        1,
  'identity':           2,
  'soul':               2,
  'gmail':              2,
  'calendar':           1,
  'contacts':           1,
  'imessage':           1,
  'api-key':            3,
  'key-documents':      2,
  'topics':             2,
  'drop-folder':        1,
  'extraction-prompts': 1,
  'context':            1,
};

// Phase groups for setup \u2014 each setup step has a `category` field from the
// API.  We bucket steps into these three phases and number them within each.
const SETUP_PHASES = [
  { key: 'core',     label: 'Foundation' },
  { key: 'data',     label: 'Data' },
  { key: 'optional', label: 'Upgrade' },
];

// Choose the action for a setup step using the fewest-clicks principle:
//   1. auth_url present \u2192 direct OAuth redirect (1 click)
//   2. inline === true  \u2192 expand inline editor in-place
//   3. everything else \u2192 openSetupInChat (chat autosend)
function _setupStepAction(step) {
  if (step.auth_url) return `window.location.href='${step.auth_url}'`;
  if (step.inline) return `toggleSetupCard('${esc(step.id)}')`;
  return `openSetupInChat('${esc(step.id)}')`;
}

function renderSetupPending() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Setup</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = appComponents().loadingState
    ? appComponents().loadingState('Loading setup...', {
      icon: 'rocket_launch',
      className: 'accounts-empty',
    })
    : '<div class="acct-loading">Loading setup...</div>';
}

function hydrateSetupInBackground(renderCycle) {
  loadAccountTabState('setup', () => _silentFetchJSON('/api/setup/progress'))
    .then((progress) => {
      if (isStaleRender(renderCycle)) return;
      _setupProgress = progress || null;
      tabDataLoaded.setup = true;
      updateSidebarCounts();
      buildSidebar(); // re-render sidebar now that progress is known (may hide setup tab)
      renderSetup(renderCycle);
    })
    .catch(() => {
      if (isStaleRender(renderCycle)) return;
      _setupProgress = null;
      tabDataLoaded.setup = true;
      renderSetup(renderCycle);
    });
}

async function renderSetup(renderCycle = _renderCycle) {
  if (!tabDataLoaded.setup) {
    const cached = _readSectionCache('setup');
    if (cached) {
      _setupProgress = cached;
      tabDataLoaded.setup = true;
      updateSidebarCounts();
      buildSidebar();
    } else {
      renderSetupPending();
      hydrateSetupInBackground(renderCycle);
      return;
    }
  }
  const feed = $('#accountsFeed');

  if (!_setupProgress) {
    $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Setup</span>';
    feed.innerHTML = `
      <div class="accounts-empty">
        <span class="material-symbols-outlined accounts-empty-icon">rocket_launch</span>
        <p>Setup isn\u2019t available right now</p>
        <p class="accounts-empty-hint">Try refreshing, or <a href="/account/integrations" onclick="setSection('integrations');return false;">connect an account</a> to get started.</p>
      </div>`;
    return;
  }

  const steps = _setupProgress.steps || [];
  const pct   = _setupProgress.completeness_pct ?? 0;

  // Compute remaining time from STEP_DURATIONS for non-resolved steps.
  const remaining = steps.filter(s => s.status !== 'complete' && s.status !== 'skip');
  const remainingMin = remaining.reduce((sum, s) => sum + (STEP_DURATIONS[s.id] || 1), 0);
  const remainingLabel = remaining.length > 0
    ? ` \u2014 ${remaining.length} left, ~${remainingMin} min`
    : ' \u2014 all done';

  $('#accountsToolbar').innerHTML = `
    <span class="accounts-toolbar-title">Setup</span>
    <span class="setup-toolbar-pct">${pct}%${remainingLabel}</span>`;

  // Bucket steps by category into phase groups.
  const buckets = { core: [], data: [], optional: [] };
  for (const step of steps) {
    const cat = step.category || 'optional';
    (buckets[cat] || buckets.optional).push(step);
  }

  let html = '<div class="setup-list">';

  for (const phase of SETUP_PHASES) {
    const phaseSteps = buckets[phase.key];
    if (!phaseSteps.length) continue;

    html += `<div class="setup-phase-header">${esc(phase.label)}</div>`;

    for (const [i, step] of phaseSteps.entries()) {
      const complete  = step.status === 'complete';
      const skipped   = step.status === 'skip';
      const done      = complete || skipped;
      const isExpanded = _expandedSetupCard === step.id;
      const numLabel  = i + 1;
      const dur       = STEP_DURATIONS[step.id];

      const glyphEl = complete
        ? '<span class="material-symbols-outlined setup-row-check">check_circle</span>'
        : skipped
          ? '<span class="material-symbols-outlined setup-row-skip">remove_circle</span>'
          : `<div class="setup-row-num">${numLabel}</div>`;

      // Time badge (shown for all steps)
      const timeEl = dur ? `<span class="setup-row-time">${dur} min</span>` : '';

      // Skip / complete icon buttons \u2014 shown on every row
      const skipBtn     = `<button class="setup-row-icon-btn${skipped ? ' active' : ''}" title="Skip" onclick="event.stopPropagation();skipSetupStep('${esc(step.id)}')"><span class="material-symbols-outlined">close</span></button>`;
      const completeBtn = `<button class="setup-row-icon-btn${complete ? ' active' : ''}" title="Mark complete" onclick="event.stopPropagation();completeSetupStep('${esc(step.id)}')"><span class="material-symbols-outlined">check</span></button>`;

      // Primary action \u2014 only shown for incomplete steps
      const actionEl = done
        ? ''
        : `<button class="setup-row-action-btn" onclick="event.stopPropagation();${_setupStepAction(step)}">${esc(step.action_label || 'Configure')}</button>`;

      // All rows are expandable; incomplete rows also fire the step action on body click.
      const rowClick = done ? `toggleSetupCard('${esc(step.id)}')` : _setupStepAction(step);
      const rowClass = `setup-row${complete ? ' setup-row-complete' : skipped ? ' setup-row-skipped' : ''}`;

      html += `
        <div class="${rowClass}" onclick="${rowClick}">
          <div class="setup-row-glyph">${glyphEl}</div>
          <div class="setup-row-body">
            <div class="setup-row-title">
              <span class="material-symbols-outlined setup-row-icon">${esc(step.icon || 'settings')}</span>
              ${esc(step.title)}
            </div>
            ${step.description ? `<div class="setup-row-desc">${esc(step.description)}</div>` : ''}
            ${isExpanded ? _setupInlineEditor(step) : ''}
          </div>
          <div class="setup-row-right">
            ${timeEl}
            ${skipBtn}${completeBtn}
            ${actionEl}
          </div>
        </div>`;
    }
  }

  html += '</div>';
  feed.innerHTML = html;
}

async function skipSetupStep(id) {
  const res = await fetchJSON(`/api/setup/steps/${encodeURIComponent(id)}/skip`, { method: 'POST' }).catch(() => null);
  if (res?.ok) await refreshSetup();
}

async function completeSetupStep(id) {
  const res = await fetchJSON(`/api/setup/steps/${encodeURIComponent(id)}/complete`, { method: 'POST' }).catch(() => null);
  if (res?.ok) await refreshSetup();
}

function _setupInlineEditor(step) {
  if (step.id === 'identity') return _identityInlineEditor();
  if (step.id === 'topics') return _topicsInlineHint();
  return '';
}

function _identityInlineEditor() {
  // Pulls from user_settings via a background fetch so we always show live values.
  // Renders immediately with placeholders; _hydrateIdentity fills in values.
  setTimeout(() => _hydrateIdentity(), 0);
  return `
    <div class="setup-inline-form" onclick="event.stopPropagation()">
      <div class="acct-form-row"><label>Name</label><input id="setupIdName" placeholder="Your name" autocomplete="name"></div>
      <div class="acct-form-row"><label>Email</label><input id="setupIdEmail" placeholder="you@example.com" autocomplete="email" type="email"></div>
      <div class="acct-form-row"><label>Timezone</label><input id="setupIdTz" placeholder="America/New_York"></div>
      <div class="acct-form-row"><label>Location</label><input id="setupIdLoc" placeholder="City, State"></div>
      <div class="acct-form-actions">
        <button class="acct-form-cancel" onclick="toggleSetupCard('identity')">Cancel</button>
        <button class="acct-form-submit" onclick="saveSetupIdentity()">Save</button>
      </div>
    </div>`;
}

async function _hydrateIdentity() {
  // Identity values live in user_settings. No dedicated read API, so we quietly
  // probe /api/preferences — if it 404s we just leave inputs blank (the preview
  // string on the card already shows what's filled).
  try {
    const res = await fetch('/api/preferences');
    if (!res.ok) return;
    const data = await res.json();
    const map = data?.preferences || data || {};
    if ($('#setupIdName'))  $('#setupIdName').value  = map.name     || '';
    if ($('#setupIdEmail')) $('#setupIdEmail').value = map.email    || '';
    if ($('#setupIdTz'))    $('#setupIdTz').value    = map.timezone || '';
    if ($('#setupIdLoc'))   $('#setupIdLoc').value   = map.location || '';
  } catch { /* optional — silent */ }
}

function _topicsInlineHint() {
  return `
    <div class="setup-inline-form" onclick="event.stopPropagation()">
      <p class="setup-inline-note">Topics are created from chat and imports. Use Assistant to refine how Miyagi understands them.</p>
    </div>`;
}

function toggleSetupCard(id) {
  _expandedSetupCard = _expandedSetupCard === id ? null : id;
  renderSetup();
}

async function saveSetupIdentity() {
  const body = {
    name:     $('#setupIdName')?.value?.trim()  || '',
    email:    $('#setupIdEmail')?.value?.trim() || '',
    timezone: $('#setupIdTz')?.value?.trim()    || '',
    location: $('#setupIdLoc')?.value?.trim()   || '',
  };
  const res = await fetchJSON('/api/setup/identity', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res?.ok) {
    showToast('Identity saved');
    _expandedSetupCard = null;
    await refreshSetup();
  } else {
    showToast('Failed to save');
  }
}

function openSetupInChat(stepId) {
  const step = _setupProgress?.steps?.find(s => s.id === stepId);
  if (!step) return;
  const url = new URL('/apps/chat/', location.origin);
  url.searchParams.set('context', step.chat_context || 'setup-guide');
  url.searchParams.set('prompt', step.chat_prompt || `Help me with ${step.title}.`);
  url.searchParams.set('autosend', 'true');
  url.searchParams.set('setup_step', step.id);
  location.href = url.toString();
}

async function setBeltOverride(belt) {
  const res = await fetchJSON('/api/setup/admin/belt-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ belt }),
  });
  if (res?.ok) {
    _adminStatus.belt_override = res.belt_override;
    showToast(belt === 'clear' ? 'Belt override cleared' : `Belt override: ${belt}`);
    renderSetup();
  } else {
    showToast('Failed to update override');
  }
}

// ===== How To Robot =====

function renderHowTo() {
  $('#accountsToolbar').innerHTML = '';
  const feed = $('#accountsFeed');
  feed.innerHTML = `
    <div class="acct-card general-howto-card" data-tab="how-to">
      <div class="general-howto-body">
        <p>Mention ${howtoKey('@miyagi')} when you want help understanding how Robot Dojo works and how to build the thing you're interested in. Miyagi answers from Robot Dojo's codebase and can explain the following and more:</p>
        <p>${howtoKey('Integrations')} bring your data into Robot Dojo. Robot Dojo turns that data into ${howtoKey('memory')} your chat can use. Your data stays local and private, even when you connect through robotdojo.ai.</p>
        <p>Creating ${howtoKey('topics')} organizes your memories and chat history into themes, which keeps chat fast, focused, and full of context you don't have to re-explain.</p>
        <p>The coding agent works the same ${howtoKey('topics')} as chat, with extra tools: working with data directly, building small apps, and writing durable conclusions back so the next session resumes.</p>
        <p>${howtoKey('Skills')} and ${howtoKey('agent personas')} give coding agents clear roles, instructions, workflows, and quality checks. They help non-technical people build with agents without needing to know every engineering step.</p>
        <p>Use the feedback button in the bottom corner to send feedback, bug reports, or feature requests. Robot Dojo strips personal and sensitive information before sending it.</p>
      </div>
    </div>`;
}

// ===== Admin =====

// Feature toggles shown in Admin tab. Health is the only launch app; future
// app drafts stay out of customer UI until promoted into the app registry.
const FEATURE_TOGGLES = [
  { key: 'health', label: 'Health', desc: 'Premium Apple Health import and analysis app.' },
];

function _effectiveBelt() {
  // Belt override (admin testing) takes precedence; fall back to subscription
  // status embedded in _adminStatus if present, else treat as white.
  if (_adminStatus.belt_override && _adminStatus.belt_override !== 'none') {
    return _adminStatus.belt_override;
  }
  return _adminStatus.belt || 'white';
}

// st_d9fc573b — Admin tab redesigned (AC 1, 2, 3, 4a). The tab is now an
// identity surface for display name, belt, server login, and account footnote.
// The old Features section, Appearance widget, and Telemetry card are removed.
// Theme toggle moves to the global topbar (shell.js).
async function renderGeneral(renderCycle = _renderCycle) {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Admin</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = '<div class="acct-loading">Loading…</div>';

  const { meData, deviceData, aboutData, whoami, profileDefaults } = await loadAccountTabState('general', async () => {
    const aboutPromise = (_initialAccountState?.about
      ? Promise.resolve(_initialAccountState.about)
      : (_initialAccountStatePromise || loadInitialAccountState()).then((state) => state?.about || null).catch(() => null));
    const [meData, deviceData, aboutData, whoami, profileDefaults] = await Promise.all([
      _silentFetchJSON('/api/auth/me'),
      fetchJSON('/api/identity/device-name').catch(() => null),
      aboutPromise,
      _silentFetchJSON('/api/whoami'),
      _silentFetchJSON('/api/accounts/profile-defaults'),
    ]);
    return { meData, deviceData, aboutData, whoami, profileDefaults };
  });
  if (isStaleRender(renderCycle)) return;

  const displayNameValue = meData?.user?.display_name || profileDefaults?.display_name || '';
  const belt = whoami?.belt || meData?.user?.belt || 'white';

  const about = aboutData || { version: '0.1.0', build_date: '', github_url: 'https://github.com/RobotDojo-AI/black-belt' };
  const deviceSlug = deviceData?.slug || deviceData?.name || 'dojo';
  const beltLabel = belt === 'black' ? 'Black Belt' : 'White Belt';
  const version = about.version || '0.1.0';
  const githubUrl = about.github_url || 'https://github.com/RobotDojo-AI/black-belt';
  const mitLicenseUrl = 'https://opensource.org/license/mit';
  const elv2LicenseUrl = 'https://www.elastic.co/licensing/elastic-license';
  const forkStatus = about.fork_status?.label || 'Forked';
  const beltFaqPrompt = encodeURIComponent('What is the difference between White Belt and Black Belt in Robot Dojo? Explain what changes when Black Belt is active or expires.');
  // st_96bb626f AC-13 — read-only per-install Black Belt expiry as a plain date.
  // No "Upgrade"/"Pay"/checkout CTA: the beta has no payment surface. Shown only
  // when the install file carries the field (backfilled/newer installs).
  let bbExpiresLabel = '';
  const bbExpiresAt = meData?.bb_expires_at || null;
  if (bbExpiresAt) {
    const d = new Date(bbExpiresAt);
    if (!Number.isNaN(d.getTime())) {
      bbExpiresLabel = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
  }

  feed.innerHTML = `
    <div class="acct-card general-kv-card" data-tab="general">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">fingerprint</span></div>
        <div class="acct-card-title"><div class="acct-card-name">Account</div></div>
      </div>
      <div class="general-kv-list">
        <div class="general-kv-row" data-row="display-name">
          <div class="general-kv-key">Display Name</div>
          <div class="general-kv-value" data-read-view>
            <span>${esc(displayNameValue || 'Not set')}</span>
            <button type="button" class="general-icon-btn" onclick="startGeneralEdit('display-name')" title="Edit display name"><span class="material-symbols-outlined icon-sm">edit</span></button>
          </div>
          <div class="general-kv-editor" data-edit-view>
            <input type="text" id="displayNameInput" class="general-kv-input" maxlength="64" value="${esc(displayNameValue)}" placeholder="Your display name" autocapitalize="words" spellcheck="false">
            <button type="button" class="general-save-btn" onclick="saveDisplayName()">Save</button>
            <button type="button" class="general-cancel-btn" onclick="cancelGeneralEdit('display-name')">Cancel</button>
          </div>
          <div class="general-kv-note">What Miyagi and other Robot Dojo apps call you. Defaults from wk_user/USER.md when present.</div>
        </div>
        <div class="general-kv-row" data-row="belt">
          <div class="general-kv-key">Belt Status</div>
          <div class="general-kv-value" data-read-view>
            <span>${esc(beltLabel)}</span>
            <a href="/chat?context=faq-pricing&prompt=${beltFaqPrompt}&autosend=true" class="general-inline-link">FAQ</a>
          </div>
          <div class="general-kv-note">White Belt knows you. Black Belt adds your wider world: people, places, companies, skills, and premium apps.</div>
        </div>
        ${bbExpiresLabel ? `
        <div class="general-kv-row" data-row="bb-expires">
          <div class="general-kv-key">Black Belt Expires</div>
          <div class="general-kv-value" data-read-view>
            <span>${esc(bbExpiresLabel)}</span>
          </div>
          <div class="general-kv-note">Your Black Belt access runs 90 days from install. There is no payment or checkout during the beta.</div>
        </div>` : ''}
        <div class="general-kv-row" data-row="fork-status">
          <div class="general-kv-key">Fork Status</div>
          <div class="general-kv-value" data-read-view>
            <span>${esc(forkStatus)}</span>
          </div>
          <div class="general-kv-note">If you edit Robot Dojo product code with a coding agent, you are running a fork; no-fork installs receive updates automatically, while forked installs manage their own merges.</div>
        </div>
      </div>
    </div>

    <div class="acct-card general-kv-card" data-tab="login" data-card="remote-access">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">vpn_key</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">Server Login</div>
          <div class="acct-card-service">The Login Token signs you in from any device. Server Name stays hidden in normal links.</div>
        </div>
      </div>
      <div class="general-kv-list">
        <div class="general-kv-row" data-row="server-name">
          <div class="general-kv-key">Server Name</div>
          <div class="general-kv-value" id="deviceNameDisplay">
            <code class="general-code-value device-slug">${esc(deviceSlug)}</code>
            <button type="button" class="general-icon-btn" onclick="startDeviceRename()" title="Edit server name"><span class="material-symbols-outlined icon-sm">edit</span></button>
          </div>
          <div class="general-kv-editor device-name-edit" id="deviceNameEditor" style="display:none">
            <input type="text" id="deviceNameInput" class="general-kv-input" maxlength="32" value="${esc(deviceSlug)}" autocapitalize="none" spellcheck="false">
            <button type="button" class="general-save-btn" id="deviceCheckBtn" onclick="prepareDeviceRename()">Save</button>
            <button type="button" class="general-cancel-btn" onclick="cancelDeviceRename()">Cancel</button>
            <div class="device-edit-hint">3-30 lowercase letters, digits, or hyphens. Defaults from this Mac, then becomes your hidden relay route.</div>
            <div class="device-edit-err" id="deviceEditErr" style="display:none"></div>
          </div>
          <div class="general-kv-note">Hidden routing name for this local Robot Dojo server.</div>
        </div>
        <div class="general-kv-row" data-row="relay-address" data-card="relay-address">
          <div class="general-kv-key">Reachable at</div>
          <div class="general-kv-value" data-read-view>
            <code class="general-code-value">${esc(deviceSlug)}.robotdojo.ai</code>
          </div>
          <div class="general-kv-note">The address other devices use to reach this dojo remotely. Certificate and routing are provisioned automatically — change the address above by editing Server Name.</div>
        </div>
        <div class="general-kv-row dojo-token-card" data-row="login-token" data-card="dojo-token">
          <div class="general-kv-key">Login Token</div>
          <div class="general-kv-value" data-read-view>
            <code class="general-code-value" data-dojo-token="masked">••••••••••••••••••••••••••••••</code>
            <button type="button" class="general-icon-btn" data-action="show-dojo-token" onclick="showDojoToken(this)" title="Show token"><span class="material-symbols-outlined icon-sm">visibility</span></button>
            <button type="button" class="general-icon-btn" data-action="copy-dojo-token" onclick="copyDojoToken(this)" title="Copy token"><span class="material-symbols-outlined icon-sm">content_copy</span></button>
            <button type="button" class="general-icon-btn" onclick="startDojoTokenEdit()" title="Edit token"><span class="material-symbols-outlined icon-sm">edit</span></button>
            <button type="button" class="general-icon-btn general-danger-btn" onclick="rotateDojoToken(this)" title="Rotate token"><span class="material-symbols-outlined icon-sm">autorenew</span></button>
          </div>
          <div class="general-kv-editor" id="dojoTokenEditor" data-edit-view>
            <input type="password" id="dojoTokenInput" class="general-kv-input" placeholder="Paste a new login token" autocomplete="off">
            <button type="button" class="general-save-btn" onclick="saveDojoToken()">Save</button>
            <button type="button" class="general-cancel-btn" onclick="cancelDojoTokenEdit()">Cancel</button>
          </div>
          <div class="general-kv-note">Rotate it if it was exposed. Rotation signs out every device and copies the new token.</div>
        </div>
      </div>
    </div>
    <div class="acct-card general-signout-card" data-row="signout">
      <button type="button" class="account-signout-btn" id="generalLogoutBtn">Sign out</button>
    </div>

    <div class="general-footnote" data-row="delete-about">
      All Robot Dojo code and data are local to this machine. To delete your account and data, just delete the Robot Dojo folder.<br>
      Robot Dojo v${esc(version)} — White Belt is licensed under the <a href="${esc(mitLicenseUrl)}" target="_blank" rel="noopener noreferrer">MIT License</a>; Black Belt under the <a href="${esc(elv2LicenseUrl)}" target="_blank" rel="noopener noreferrer">Elastic License 2.0</a>.
      <a href="${esc(githubUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>.
    </div>`;

  const logoutBtn = document.getElementById('generalLogoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      try {
        await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
      } catch { /* sign-out is best-effort; clear cookie + navigate anyway */ }
      window.location.href = '/login';
    });
  }
}

// st_d9fc573b — Save the user description to /api/account/description.
async function saveDescription() {
  const input = $('#descriptionInput');
  if (!input) return;
  const description = input.value.trim();
  const res = await fetchJSON('/api/account/description', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  }).catch(() => null);
  if (res?.ok) showToast('Description saved');
  else showToast('Saved locally');
}

// Save feature flag toggle. Mirrors toggleBetaApp but uses a feature-flags key
// so the backend can distinguish feature toggles from beta app opt-ins.
async function toggleFeatureFlag(key, on) {
  _betaState[key] = !!on;
  try { localStorage.setItem('rd_beta_optin', JSON.stringify(_betaState)); } catch { /* */ }
  const res = await fetchJSON('/api/account/beta-opt-in', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: key, opt_in: !!on }),
  });
  if (!res?.ok && !res) showToast('Saved locally — backend not ready');
  else showToast(`${key}: ${on ? 'on' : 'off'}`);
}

// ===== Assistant (was: Foundation / Identity) =====
// Renamed from renderFoundation in Phase 4 — dispatcher and all backward-compat
// aliases (foundation, identity) now point here. Toolbar title stays "Assistant"
// to match the sidebar nav label.
// st_d9fc573b — Assistant tab opens with the canonical AGENTS.md card:
//   * Body comes from /api/accounts/agents-md (state: ready | onboarding).
//   * Edit button is an anchor to /chat?prefill=<encoded AGENTS.md prompt>
//     so the chat textarea pre-fills with the right starter (AC 10).
//   * Persona target row renders SUPPORTED_TARGETS as toggle icons that
//     POST to /api/accounts/persona-sync (AC 11).
// The existing identity-card grid stays beneath for backward compat.
async function renderAssistant() {
  $('#accountsToolbar').innerHTML = `
    <span class="accounts-toolbar-title">Assistant</span>
    <button class="acct-add-btn" onclick="recalcIdentity()" title="Recalculate identity from your data" style="margin-right:8px">
      <span class="material-symbols-outlined">refresh</span> Recalculate
    </button>
    <button class="acct-add-btn" onclick="pushIdentityExport()" title="Update every enabled AI tool adapter">
      <span class="material-symbols-outlined">ios_share</span> Update tool adapters
    </button>`;
  const feed = $('#accountsFeed');
  feed.innerHTML = `<div class="accounts-empty acct-loading" style="min-height:200px">Loading identity…</div>`;

  // st_d9fc573b — Fetch AGENTS.md content + persona target state in parallel
  // with the legacy identity snapshot so first paint shows everything.
  const [snapRes, statusRes, agentsRes, personaRes] = await Promise.allSettled([
    fetchJSON('/api/identity/snapshot'),
    fetchJSON('/api/identity/export-status'),
    _silentFetchJSON('/api/accounts/agents-md'),
    _silentFetchJSON('/api/accounts/persona-sync'),
  ]);
  if (snapRes.status !== 'fulfilled' || statusRes.status !== 'fulfilled') {
    feed.innerHTML = `<div class="accounts-empty" style="padding:24px">
      <p>Couldn't load identity. <code>${esc(snapRes.reason?.message || statusRes.reason?.message || 'unknown')}</code></p>
    </div>`;
    return;
  }
  const snap = snapRes.value;
  const status = statusRes.value;
  const agents = agentsRes.value || { state: 'ready', content: '' };
  const personaTargets = (personaRes.value && Array.isArray(personaRes.value.targets)) ? personaRes.value.targets : [];

  // st_d9fc573b AC 10 — Edit anchor links to /chat?prefill=<urlencoded prompt>.
  // The prompt MUST contain the substring "agents" (case-insensitive) — VC 10
  // greps for it.
  const prefillPrompt = 'Help me edit my agents persona (AGENTS.md). Read it, summarize it, and ask what I want to change.';
  const editHref = `/chat?prefill=${encodeURIComponent(prefillPrompt)}`;

  // Render identity bodies through the shared prose component so persona cards
  // match every other markdown surface (one sanitizer, one typographic scale)
  // instead of a bespoke div. framed:false keeps the card's own chrome; the
  // identity-content wrapper carries only the no-embedded-scroll layout.
  const components = appComponents();
  const renderIdentityProse = (content) => (typeof components.prose === 'function'
    ? `<div class="identity-content">${components.prose({ content, className: 'identity-prose', framed: false })}</div>`
    : `<div class="identity-content identity-prose">${renderMarkdown(content || '')}</div>`);

  const agentsBodyHtml = agents.state === 'onboarding'
    ? `<div class="identity-empty"><p>${esc(agents.content || 'Currently building agent profile from your history')}</p></div>`
    : renderIdentityProse(agents.content || '');
  try {
    /* eslint-disable no-undef */
    const card = {};
    void card; // keep linter happy in this scope
  } catch {}

  const agentsCardHtml = `
    <div class="acct-card identity-card" data-slug="agents-md">
      <div class="identity-header">
        <div class="identity-card-icon"><span class="material-symbols-outlined">smart_toy</span></div>
        <div class="identity-card-title">
          <div class="identity-card-name">AGENTS.md</div>
          <div class="identity-card-verb">Canonical agent persona</div>
        </div>
        <a class="identity-edit-btn" href="${esc(editHref)}">Edit</a>
      </div>
      <div class="identity-body">
        <div class="identity-meta">State: ${esc(agents.state || 'ready')}</div>
        ${agentsBodyHtml}
      </div>
    </div>`;

  // st_d9fc573b AC 11 — Persona target row with one icon-toggle per supported target.
  const SUPPORTED_TARGETS = [
    { name: 'claude_code',  label: 'Claude Code',  icon: 'code' },
    { name: 'cursor',       label: 'Cursor',       icon: 'code' },
    { name: 'chatgpt',      label: 'ChatGPT',      icon: 'smart_toy' },
    { name: 'gemini',       label: 'Gemini',       icon: 'auto_awesome' },
    { name: 'claude_desktop', label: 'Claude Desktop', icon: 'desktop_windows' },
  ];
  const enabledByName = new Map(personaTargets.map(t => [t.name, !!t.enabled]));
  const personaRowHtml = `
    <div class="acct-card" data-card="persona-sync">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">ios_share</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">Agent persona targets</div>
          <div class="acct-card-service">Keep AGENTS.md available to each enabled tool on every change.</div>
        </div>
      </div>
      <div class="persona-sync-targets">
        ${SUPPORTED_TARGETS.map(t => `
          <button type="button" class="persona-sync-toggle ${enabledByName.get(t.name) ? 'is-enabled' : ''}"
                  data-target="${esc(t.name)}"
                  onclick="togglePersonaSyncTarget('${esc(t.name)}', this)"
                  title="${esc(t.label)}">
            <span class="material-symbols-outlined">${esc(t.icon)}</span>
            <span class="persona-sync-label">${esc(t.label)}</span>
          </button>`).join('')}
      </div>
    </div>`;

  // Render the AGENTS.md + persona-sync cards before the existing identity
  // grid; subsequent renderCard() output is appended below the new cards.
  feed.innerHTML = agentsCardHtml + personaRowHtml;

  const renderCard = (card) => {
    const icon = IDENTITY_SECTION_ICONS[card.slug] || 'bookmark';
    const subtitle = card.verb ? esc(card.verb) : '';
    const meta = card.updatedAt
      ? `Last updated ${formatUpdatedAt(card.updatedAt)} &middot; ${card.bytes.toLocaleString()} bytes`
      : (card.empty ? 'Empty' : `${card.bytes.toLocaleString()} bytes`);
    const bodyHtml = card.empty
      ? `<div class="identity-empty">
           <p>This card is empty. <button type="button" class="identity-empty-cta" onclick="editIdentityCard('${esc(card.slug)}')">Shape it with Miyagi</button>.</p>
         </div>`
      : renderIdentityProse(card.body);

    // The User card gets an additional "Links" section for storing profile URLs
    // (LinkedIn, GitHub, personal site, etc.). Links are stored as a fenced
    // markdown comment block inside the card body so they survive log round-trips.
    let linksSection = '';
    if (card.slug === 'user') {
      _userCardBody = card.body || '';
      _userLinks = _parseUserLinks(_userCardBody);
      const chipsHtml = _userLinks.map((url, i) => `
        <span class="user-link-chip">
          <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>
          <button type="button" class="user-link-remove" onclick="removeUserLink(${i})" title="Remove">×</button>
        </span>`).join('');
      linksSection = `
        <div class="user-links-section">
          <div class="user-links-label">Links</div>
          <div id="userLinkChips" class="user-links-chips">${chipsHtml}</div>
          <div class="user-links-add">
            <input id="userLinkInput" type="url" class="user-link-input" placeholder="https://linkedin.com/in/…">
            <button type="button" class="user-link-add-btn" onclick="addUserLink()">Add</button>
          </div>
        </div>`;
    }

    return `
      <div class="acct-card identity-card" data-slug="${esc(card.slug)}">
        <div class="identity-header" onclick="toggleIdentityCard(this)">
          <div class="identity-card-icon"><span class="material-symbols-outlined">${icon}</span></div>
          <div class="identity-card-title">
            <div class="identity-card-name">${esc(card.label)}</div>
            ${subtitle ? `<div class="identity-card-verb">${subtitle}</div>` : ''}
          </div>
          <button type="button" class="identity-edit-btn" onclick="event.stopPropagation();editIdentityCard('${esc(card.slug)}')">Edit in chat</button>
          <!-- Cards open by default — chevron points up (expand_less = collapsed indicator) -->
          <span class="material-symbols-outlined identity-chevron">expand_less</span>
        </div>
        <div class="identity-body">
          <div class="identity-meta">${meta}</div>
          ${bodyHtml}
          ${linksSection}
        </div>
      </div>`;
  };

  const formatUpdatedAt = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return iso; }
  };

  const groups = snap.groups || [
    { id: 'your-ai', label: 'Your AI', subtitle: '' },
    { id: 'you',     label: 'You',     subtitle: '' },
  ];
  const cardHtml = groups.map((g) => {
    const groupCards = (snap.cards || []).filter((c) => (c.group || 'your-ai') === g.id);
    if (!groupCards.length) return '';
    return `
      <div class="identity-group-header">
        <div class="identity-group-title">${esc(g.label)}</div>
        ${g.subtitle ? `<div class="identity-group-subtitle">${esc(g.subtitle)}</div>` : ''}
      </div>
      ${groupCards.map(renderCard).join('')}`;
  }).join('');

  // AI tool adapters rendered as toggle rows instead of a table — each adapter
  // has a switch that POSTs to /api/identity/export-target/:id to persist the
  // enabled state. The toggle degrades gracefully if the endpoint isn't ready.
  const adapterHtml = (status.adapters || []).map((a, i) => {
    let statusDesc;
    const kindLabel = a.kind === 'auto-sync' ? 'automatic' : a.kind;
    if (a.kind === 'auto-sync') {
      statusDesc = a.path || a.defaultPath || '';
    } else {
      statusDesc = a.enabled
        ? (a.needsInstall ? 'needs re-paste (version mismatch)' : a.installedVersion ? 'v' + a.installedVersion : '')
        : '';
    }
    return `
      <div class="rel-toggle-row">
        <div class="rel-toggle-label">
          <div class="rel-toggle-name">${esc(a.label)} <span style="font-size:11px;opacity:.55">${esc(kindLabel)}</span></div>
          ${statusDesc ? `<div class="rel-toggle-desc" style="font-family:var(--mono);font-size:11px">${esc(statusDesc)}</div>` : ''}
        </div>
        ${_switchHtml('export_' + esc(a.id), !!a.enabled, `toggleExportTarget('${esc(a.id)}', this.checked)`)}
      </div>${i < (status.adapters.length - 1) ? '<div class="rel-divider"></div>' : ''}`;
  }).join('');

  // Onboarding reminder when no integrations are connected
  const onboardingBanner = (_integrationCards?.connected === 0)
    ? `<div class="acct-notice">Connect integrations to auto-populate your identity profile.</div>`
    : '';

  // st_d9fc573b — append the legacy identity grid + AI-tool-adapter card BELOW
  // the new AGENTS.md + persona-sync cards rendered at the top of this fn.
  feed.innerHTML += `
    ${onboardingBanner}
    <div style="padding:12px 4px;opacity:.7;font-size:13px">
      Identity lives in an append-only hash-chained log at <code>~/robotdojo/user/memory/log/</code>.
      Each edit appends a new version; latest wins. Old versions stay for audit.
    </div>
    ${cardHtml}
    <div class="acct-card" style="margin-top:24px">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">ios_share</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">AI Tool Adapters</div>
          <div class="acct-card-service">${esc(status.adapters.filter((a) => a.enabled).length)} of ${status.adapters.length} enabled &middot; version <code>${esc(status.currentHash)}</code></div>
        </div>
      </div>
      ${adapterHtml}
    </div>`;
}

// st_4e7e3aaf AC9 — Agents page renders six per-persona cards in canonical
// PERSONA_ORDER read from /api/accounts/agent-personas. The legacy
// AGENTS.md blob is gone (root file does not exist in this repo). Persona
// cards are READ-ONLY in the UI per owner: curated product summaries on the
// page, with "See Agent" opening the canonical markdown file.
async function renderAgents(renderCycle = _renderCycle) {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Agents</span>';
  const feed = $('#accountsFeed');
  // Cache-aware render: paint from persisted cache first, kick off background
  // revalidation, fall through to a network fetch only if the cache is empty.
  const cached = _readSectionCache('agent-personas');
  if (cached) {
    _renderAgentsFromData(cached);
    _revalidateAgentsInBackground();
    return;
  }
  feed.innerHTML = '<div class="acct-loading">Loading…</div>';
  const data = await _silentFetchJSON('/api/accounts/agent-personas');
  if (isStaleRender(renderCycle)) return;
  if (!Array.isArray(data) || !data.length) {
    feed.innerHTML = `<div class="accounts-empty">
      <span class="material-symbols-outlined accounts-empty-icon">smart_toy</span>
      <p>Could not load agents</p>
    </div>`;
    return;
  }
  _writeSectionCache('agent-personas', data);
  _renderAgentsFromData(data);
}

function _renderAgentsFromData(personas) {
  const feed = $('#accountsFeed');
  feed.innerHTML = `
    ${_renderShowcaseLede(
      'Agent personas',
      'Personas define judgment: who thinks, what failure mode they catch, and what taste they bring. Skills define protocol: goal routes the outcome into defect, story, or work; individual skills then carry the record through proof. Robot Dojo needs both: a thinker and a track.'
    )}
    <div class="identity-showcase-grid">
      ${personas.map((p) => {
    const kanji = p.kanji ? `<span class="identity-card-kanji">${esc(p.kanji)}</span>` : '';
        const targetId = p.id || `agent:${String(p.displayName || '').toLowerCase()}`;
        return _renderShowcaseCard({
          kind: 'agent',
          icon: 'smart_toy',
          eyebrow: AGENT_SHOWCASE_ROLE[p.displayName] || p.role || 'Agent',
          title: `${kanji}<span class="identity-card-displayname">${esc(p.displayName)}</span>`,
          path: p.path || `agents/personas/${p.displayName}.md`,
          sentences: AGENT_SHOWCASE_COPY[p.displayName] || [p.description || 'This agent is part of the Robot Dojo operating system.'],
          actionLabel: 'See Agent',
          targetId,
        });
      }).join('')}
    </div>`;
}

async function _revalidateAgentsInBackground() {
  const fresh = await _silentFetchJSON('/api/accounts/agent-personas');
  if (!Array.isArray(fresh) || !fresh.length) return;
  const cached = _readSectionCache('agent-personas');
  if (JSON.stringify(cached) === JSON.stringify(fresh)) return;
  _writeSectionCache('agent-personas', fresh);
  if (activeSection === 'agents') _renderAgentsFromData(fresh);
}

async function renderYou() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">You</span>';
  $('#accountsFeed').innerHTML = _renderMemoryPromptPanel();
  hydrateMemoryPromptPanel();
}

async function renderSkills(renderCycle = _renderCycle) {
  return renderEditTargetList('skills', 'Skills', 'construction', renderCycle);
}

// st_4e7e3aaf AC10 — open the edit target's real file in the user's
// default editor for `.md` files. The server resolves the path from a
// fixed allowlist (editTargetMap()); the client supplies only the id.
async function openEditTarget(id) {
  try {
    const res = await fetch(`/api/accounts/open-target?id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      showToast('Opened in editor');
      return;
    }
    if (data?.error === 'open_failed') {
      showToast(`Open failed: ${data.detail || 'unknown error'}`);
    } else if (data?.error === 'unknown_target') {
      showToast('Unknown edit target');
    } else {
      showToast('Could not open file');
    }
  } catch {
    showToast('Could not open file');
  }
}
window.openEditTarget = openEditTarget;

async function renderShortcuts() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Shortcuts</span>';
  const shortcuts = _currentShortcuts();
  // st_4e7e3aaf AC12 — render shortcuts in labeled groups. Each shortcut
  // carries a "group" field (chat / navigation / organization / app);
  // GROUP_ORDER drives the section order. A shortcut without a group lands
  // in a trailing "Other" bucket so additions never silently disappear.
  const groupOrder = (window.RobotDojoShortcuts?.GROUP_ORDER) || ['chat', 'navigation', 'organization', 'app'];
  const groupLabels = (window.RobotDojoShortcuts?.GROUP_LABELS) || { chat: 'Chat', navigation: 'Navigation', organization: 'Organization', app: 'App' };
  const buckets = new Map(groupOrder.map((g) => [g, []]));
  const other = [];
  for (const s of shortcuts) {
    if (buckets.has(s.group)) buckets.get(s.group).push(s);
    else other.push(s);
  }
  const rowHtml = (shortcut) => `<div class="account-shortcut-row" data-shortcut-id="${esc(shortcut.id)}"><span>${esc(shortcut.label)}</span><span class="keys">${(shortcut.keys || []).map((key) => `<kbd>${esc(key)}</kbd>`).join('')}<button class="general-icon-btn" onclick="editShortcut('${esc(shortcut.id)}')" title="Edit shortcut"><span class="material-symbols-outlined icon-sm">edit</span></button></span></div>`;
  const sections = [];
  for (const g of groupOrder) {
    const rows = buckets.get(g);
    if (!rows.length) continue;
    sections.push(`<div class="shortcut-group-header">${esc(groupLabels[g] || g)}</div>${rows.map(rowHtml).join('')}`);
  }
  if (other.length) {
    sections.push(`<div class="shortcut-group-header">Other</div>${other.map(rowHtml).join('')}`);
  }
  $('#accountsFeed').innerHTML = `
    <div class="acct-card shortcuts-card">
      <div class="acct-card-header">
        <span class="material-symbols-outlined acct-card-icon">keyboard</span>
        <div class="acct-card-title">
          <div class="acct-card-name">Keyboard Shortcuts</div>
          <div class="acct-card-service">Type the shortcut you want while editing. Chat uses these immediately.</div>
        </div>
        <button class="acct-action-btn" onclick="resetShortcuts()" title="Reset shortcuts"><span class="material-symbols-outlined icon-sm">restart_alt</span> Reset</button>
      </div>
      <div class="account-shortcut-grid">
        ${sections.join('')}
      </div>
    </div>`;
}

function _currentShortcuts() {
  return window.RobotDojoShortcuts?.load?.() || [];
}

function editShortcut(id) {
  const shortcuts = _currentShortcuts();
  const shortcut = shortcuts.find((s) => s.id === id);
  if (!shortcut) return;
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay shortcut-capture-overlay';
  overlay.innerHTML = `<div class="confirm-modal shortcut-capture-modal"><h3>Edit Shortcut</h3><p>${esc(shortcut.label)}</p><div class="shortcut-capture-box" tabindex="0">Type shortcut</div><div class="confirm-actions"><button class="cancel-btn">Cancel</button></div></div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector('.shortcut-capture-box');
  const close = () => overlay.remove();
  overlay.querySelector('.cancel-btn').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  box.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { close(); return; }
    const combo = window.RobotDojoShortcuts?.eventToCombo?.(e);
    if (!combo) return;
    window.RobotDojoShortcuts.saveShortcut(id, combo);
    close();
    renderShortcuts();
  });
  setTimeout(() => box.focus(), 50);
}
window.editShortcut = editShortcut;

function resetShortcuts() {
  window.RobotDojoShortcuts?.reset?.();
  renderShortcuts();
}
window.resetShortcuts = resetShortcuts;

async function renderEditTargetList(kind, title, iconName, renderCycle = _renderCycle) {
  $('#accountsToolbar').innerHTML = `<span class="accounts-toolbar-title">${esc(title)}</span>`;
  const feed = $('#accountsFeed');
  // st_4e7e3aaf AC5 — cache-first render. Paint from persisted cache, then
  // revalidate in background. Spinner only on first-ever load.
  let data = _readSectionCache('edit-targets');
  if (data) {
    _renderEditTargetListFromData(kind, title, iconName, data);
    revalidateSectionInBackground('edit-targets').catch(() => { /* */ });
    return;
  }
  feed.innerHTML = '<div class="acct-loading">Loading…</div>';
  data = await loadAccountTabState('edit-targets', () => _silentFetchJSON('/api/accounts/edit-targets'));
  if (isStaleRender(renderCycle)) return;
  if (data) _writeSectionCache('edit-targets', data);
  _renderEditTargetListFromData(kind, title, iconName, data);
}

function _renderEditTargetListFromData(kind, title, iconName, data) {
  const feed = $('#accountsFeed');
  const section = data?.[kind];
  const targets = Array.isArray(section?.targets) ? section.targets : [];
  if (!targets.length) {
    feed.innerHTML = `<div class="accounts-empty">
      <span class="material-symbols-outlined accounts-empty-icon">${esc(iconName)}</span>
      <p>No ${esc(title.toLowerCase())} sources found</p>
    </div>`;
    return;
  }
  feed.innerHTML = `
    ${_renderShowcaseLede(
      'Skill protocols',
      'Goal is the top level: state the outcome once, then Robot Dojo routes it into defect, story, or work. Individual skills carry the approved path through framing, research, scope, plan, build, QA, and close.'
    )}
    ${_renderSkillOntologyMap(targets)}
    <div class="identity-showcase-grid">
      ${targets.map((target) => {
        const key = String(target.label || '').toLowerCase();
        const eyebrow = key === 'goal'
          ? 'Top level'
          : ['story', 'defect', 'work'].includes(key)
            ? 'Work type'
            : 'Individual skill';
        return _renderShowcaseCard({
          kind: 'skill',
          icon: iconName,
          eyebrow,
          title: esc(_titleCase(target.label || 'Skill')),
          path: target.path || '',
          sentences: SKILL_SHOWCASE_COPY[key] || ['This skill gives Robot Dojo a repeatable way to move work through the system.'],
          actionLabel: 'See Skill',
          targetId: target.id,
        });
      }).join('')}
    </div>`;
}

function _titleCase(value) {
  if (String(value || '').toLowerCase() === 'qa') return 'QA';
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function _renderSkillOntologyMap(targets) {
  const byKey = new Map((targets || []).map((target) => [String(target.label || '').toLowerCase(), target]));
  const goalKeys = ['goal'];
  const entryKeys = ['defect', 'story', 'work'];
  const pathKeys = ['framing', 'research', 'scope', 'plan', 'build', 'qa', 'close'];
  const chip = (key, phase) => {
    const target = byKey.get(key);
    const label = _titleCase(target?.label || key);
    const targetId = target?.id || '';
    return `<button type="button" class="skill-map-chip skill-map-chip-${esc(phase)}" ${targetId ? `onclick="openEditTarget('${esc(targetId)}')"` : ''}>${esc(label)}</button>`;
  };
  const path = pathKeys
    .map((key, idx) => `${idx ? '<span class="skill-map-arrow material-symbols-outlined">arrow_forward</span>' : ''}${chip(key, 'stage')}`)
    .join('');
  return `
    <div class="skill-ontology-map" aria-label="Skill ontology map">
      <div class="skill-map-row skill-map-row-goal">
        <div class="skill-map-label">Top level</div>
        <div class="skill-map-track">${goalKeys.map((key) => chip(key, 'goal')).join('')}</div>
      </div>
      <div class="skill-map-row skill-map-row-entry">
        <div class="skill-map-label">Work types</div>
        <div class="skill-map-track">${entryKeys.map((key) => chip(key, 'entry')).join('')}</div>
      </div>
      <div class="skill-map-row skill-map-row-path">
        <div class="skill-map-label">Individual skills</div>
        <div class="skill-map-track skill-map-track-path">${path}</div>
      </div>
    </div>`;
}

function _renderShowcaseLede(title, text) {
  return `
    <div class="identity-showcase-lede">
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
    </div>`;
}

function _renderShowcaseCard({ kind, icon, eyebrow, title, path, sentences, actionLabel, targetId }) {
  return `
    <article class="acct-card identity-showcase-card" data-showcase-kind="${esc(kind)}" data-source="${esc(targetId || '')}">
      <div class="identity-showcase-card-head">
        <div class="identity-card-icon"><span class="material-symbols-outlined">${esc(icon)}</span></div>
        <div class="identity-card-title">
          <div class="identity-showcase-eyebrow">${esc(eyebrow || '')}</div>
          <div class="identity-card-name">${title}</div>
          ${path ? `<div class="identity-card-verb identity-code-text">${esc(path)}</div>` : ''}
        </div>
      </div>
      <div class="identity-showcase-copy">
        ${(sentences || []).slice(0, 5).map((sentence) => `<p>${esc(sentence)}</p>`).join('')}
      </div>
      <div class="identity-showcase-actions">
        <button type="button" class="identity-see-btn" onclick="openEditTarget('${esc(targetId)}')">
          <span>${esc(actionLabel || 'See Source')}</span>
          <span class="material-symbols-outlined icon-sm">open_in_new</span>
        </button>
      </div>
    </article>`;
}

// st_d9fc573b AC 11 — POST persona-sync toggle to /api/accounts/persona-sync.
async function togglePersonaSyncTarget(name, btnEl) {
  const enabled = !(btnEl && btnEl.classList.contains('is-enabled'));
  const res = await fetchJSON('/api/accounts/persona-sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: name, enabled }),
  });
  if (res && (res.ok || res.target)) {
    if (btnEl) btnEl.classList.toggle('is-enabled', enabled);
    showToast(`${name}: ${enabled ? 'on' : 'off'}`);
  } else {
    showToast(res?.error || 'Could not update adapter target');
  }
}

function toggleIdentityCard(headerEl) {
  const card = headerEl.closest('.identity-card');
  const body = card.querySelector('.identity-body');
  const chevron = card.querySelector('.identity-chevron');
  // Cards are open by default (no display:none in the template).
  // We track closed state via the `collapsed` class so CSS can animate.
  const isOpen = body.style.display !== 'none';
  if (isOpen) {
    body.style.display = 'none';
    chevron.textContent = 'expand_more';
  } else {
    body.style.display = '';
    chevron.textContent = 'expand_less';
  }
}

function editIdentityCard(slug) {
  // Use ?prompt= + ?autosend= which is what the chat app reads.
  // The old ?initial= parameter is no longer recognised by /chat/.
  const prompt = encodeURIComponent(`Let's refine my ${slug} card. Read the current version first (use read_identity_section), then ask me what I want to change.`);
  window.location.href = `/chat/?prompt=${prompt}&autosend=true`;
}

async function saveDisplayName() {
  const input = document.getElementById('displayNameInput');
  if (!input) return;
  const val = input.value.trim();
  const res = await fetchJSON('/api/account/display-name', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: val }),
  });
  showToast(res?.ok ? 'Display name saved' : (res?.error || 'Failed to save'));
  if (res?.ok) {
    invalidateAccountTabState('general');
    await renderGeneral();
  }
}

function startGeneralEdit(row) {
  const el = document.querySelector(`[data-row="${row}"]`);
  if (!el) return;
  el.classList.add('is-editing');
  const input = el.querySelector('input, select');
  if (input) { input.focus(); input.select(); }
}
window.startGeneralEdit = startGeneralEdit;

function cancelGeneralEdit(row) {
  const el = document.querySelector(`[data-row="${row}"]`);
  if (el) el.classList.remove('is-editing');
}
window.cancelGeneralEdit = cancelGeneralEdit;

function startHandleRename() {
  document.getElementById('handleRenameRow').style.display = '';
  const input = document.getElementById('handleInput');
  input.focus();
  input.select();
}
function cancelHandleRename() {
  document.getElementById('handleRenameRow').style.display = 'none';
  const err = document.getElementById('handleEditErr');
  if (err) err.style.display = 'none';
}
async function confirmHandleRename() {
  const input = document.getElementById('handleInput');
  const errBox = document.getElementById('handleEditErr');
  const value = input.value.trim().toLowerCase();
  errBox.style.display = 'none';

  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(value) && !/^[a-z0-9]{3,30}$/.test(value)) {
    errBox.textContent = '3–30 lowercase letters, digits, hyphens. No leading/trailing hyphens.';
    errBox.style.display = '';
    return;
  }

  try {
    const res = await fetchJSON('/api/identity/handle', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: value }),
    });
    if (!res?.ok) {
      errBox.textContent = res?.message || res?.error || 'Could not update handle.';
      errBox.style.display = '';
      return;
    }
    document.getElementById('handleDisplay').textContent = value;
    cancelHandleRename();
  } catch (err) {
    errBox.textContent = err.body?.message || err.body?.error || err.message || 'Update failed.';
    errBox.style.display = '';
  }
}

function startDeviceRename() {
  document.getElementById('deviceNameDisplay').style.display = 'none';
  document.getElementById('deviceNameEditor').style.display = 'flex';
  const input = document.getElementById('deviceNameInput');
  input.focus();
  input.select();
}
function cancelDeviceRename() {
  document.getElementById('deviceNameDisplay').style.display = 'flex';
  document.getElementById('deviceNameEditor').style.display = 'none';
  const err = document.getElementById('deviceEditErr');
  if (err) err.style.display = 'none';
}

// Step 1: validate slug locally, call /prepare to claim it at the relay,
// then show a confirmation modal with the disconnect warning.
async function prepareDeviceRename() {
  const input = document.getElementById('deviceNameInput');
  const errBox = document.getElementById('deviceEditErr');
  const btn = document.getElementById('deviceCheckBtn');
  const value = input.value.trim().toLowerCase();
  errBox.style.display = 'none';

  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(value) && !/^[a-z0-9]{3,30}$/.test(value)) {
    errBox.textContent = '3–30 lowercase letters, digits, hyphens. No leading/trailing hyphens.';
    errBox.style.display = '';
    return;
  }

  btn.disabled = true;
    btn.textContent = 'Saving…';
  try {
    const res = await fetchJSON('/api/identity/device-name/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: value }),
    });

    if (!res?.ok) {
      if (res?.error === 'slug_taken') {
        errBox.textContent = 'That name is already taken. Try another.';
      } else {
        errBox.textContent = res?.message || 'Could not check availability. Try again.';
      }
      errBox.style.display = '';
      return;
    }

    // Slug is claimed — show the confirmation modal.
    _showDeviceRenameConfirmModal(res.token, res.newSlug);
  } catch (err) {
    const msg = err.body?.message || err.body?.error || err.message || 'Availability check failed.';
    errBox.textContent = msg;
    errBox.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

// State for the pending rename token (set by prepare, consumed by confirm).
let _pendingRenameToken = null;

function _showDeviceRenameConfirmModal(token, newSlug) {
  _pendingRenameToken = token;

  // Get current slug from the display element.
  const currentSlugEl = document.querySelector('#deviceNameDisplay .device-slug');
  const currentSlug = currentSlugEl ? currentSlugEl.textContent : '(current)';

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.id = 'deviceRenameOverlay';
  overlay.innerHTML = `
    <div class="confirm-modal">
      <h3>Rename your device</h3>
      <p>
        Current: <code>${esc(currentSlug)}</code><br>
        New: <code>${esc(newSlug)}</code>
      </p>
      <p style="margin-top:8px">
        Your browser will disconnect for ~10 seconds while the device restarts. This is normal.
      </p>
      <div class="confirm-actions">
        <button class="cancel-btn" id="deviceRenameCancelBtn">Cancel</button>
        <button class="confirm-btn" id="deviceRenameConfirmBtn">Confirm rename</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('deviceRenameCancelBtn').onclick = () => {
    overlay.remove();
    _pendingRenameToken = null;
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      _pendingRenameToken = null;
    }
  });
  document.getElementById('deviceRenameConfirmBtn').onclick = () => {
    overlay.remove();
    _confirmDeviceRename(newSlug);
  };
}

// Step 2: send the token to /confirm, then show reconnecting state and poll.
async function _confirmDeviceRename(newSlug) {
  const token = _pendingRenameToken;
  _pendingRenameToken = null;
  if (!token) return;

  const errBox = document.getElementById('deviceEditErr');
  errBox.style.display = 'none';

  // Show reconnecting state in the editor area.
  const editor = document.getElementById('deviceNameEditor');
  if (editor) {
    editor.innerHTML = `<div class="device-edit-hint" id="deviceReconnectMsg">
      Device renamed to <code>${esc(newSlug)}</code>. Reconnecting…
    </div>`;
  }

  try {
    const res = await fetchJSON('/api/identity/device-name/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!res?.ok) {
      // Restore editor so user can try again.
      renderAssistant();
      return;
    }
  } catch {
    // Server is restarting — this is expected.
  }

  // Poll GET /api/identity/device-name every 2s until the server comes back.
  const deadline = Date.now() + 30_000;
  let reconnected = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const check = await fetch('/api/identity/device-name');
      if (check.ok) { reconnected = true; break; }
    } catch { /* still restarting */ }
  }

  if (reconnected) {
    showToast(`Renamed to "${newSlug}". Reconnected.`);
    renderAssistant();
  } else {
    const msg = document.getElementById('deviceReconnectMsg');
    if (msg) msg.textContent = `Rename complete. Refresh when ready.`;
  }
}

async function recalcIdentity() {
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined">refresh</span> Recalculating…'; }
  try {
    const res = await fetchJSON('/api/identity/recalc', { method: 'POST' });
    if (res?.ok) {
      showToast('Identity recalculated');
      if (btn) btn.innerHTML = '<span class="material-symbols-outlined">check</span> Done';
      setTimeout(() => { renderAssistant(); }, 1500);
    } else {
      showToast(res?.error || 'Recalc failed');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">refresh</span> Recalculate'; }
    }
  } catch (err) {
    showToast(err.message || 'Recalc failed');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">refresh</span> Recalculate'; }
  }
}

async function pushIdentityExport() {
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined">ios_share</span> Updating…'; }
  try {
    const res = await fetchJSON('/api/identity/export', { method: 'POST' });
    if (res?.ok) {
      if (btn) btn.innerHTML = `<span class="material-symbols-outlined">check</span> ${res.autoSynced} updated, ${res.guidedPending} pending paste`;
      setTimeout(() => { renderAssistant(); }, 1500);
    } else {
      if (btn) btn.innerHTML = `<span class="material-symbols-outlined">error</span> ${esc(res?.error || 'failed')}`;
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    if (btn) btn.innerHTML = `<span class="material-symbols-outlined">error</span> ${esc(err.message)}`;
    if (btn) btn.disabled = false;
  }
}

// Toggle an export target on or off. Calls the backend PATCH endpoint added
// in Phase 4; degrades gracefully if the endpoint isn't available yet.
async function toggleExportTarget(id, enabled) {
  const res = await fetchJSON(`/api/identity/export-target/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  });
  if (res?.ok) showToast(`${id}: ${enabled ? 'enabled' : 'disabled'}`);
  else showToast(res?.error || 'Saved locally — backend not ready');
}

// ===== URL chip helpers for the User card =====

// Load URLs from the user card body. URLs are stored as a special fenced
// section at the end of the markdown body so they survive round-trips through
// the identity log without mangling the prose content.
function _parseUserLinks(body) {
  const match = body.match(/^<!-- links -->\n([\s\S]*?)(?:\n<!-- \/links -->|$)/m);
  if (!match) return [];
  return match[1].trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
}

function _serializeUserLinks(body, links) {
  // Strip existing links block then append a fresh one
  const stripped = body.replace(/\n?<!-- links -->\n[\s\S]*?(?:\n<!-- \/links -->|$)/m, '').trimEnd();
  if (!links.length) return stripped;
  return stripped + '\n<!-- links -->\n' + links.join('\n') + '\n<!-- /links -->';
}

// Re-render just the chips area inside the user card without a full page reload.
function _refreshUserLinkChips(links) {
  const container = document.getElementById('userLinkChips');
  if (!container) return;
  container.innerHTML = links.map((url, i) => `
    <span class="user-link-chip">
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>
      <button type="button" class="user-link-remove" onclick="removeUserLink(${i})" title="Remove">×</button>
    </span>`).join('');
}

// Global for the current user card URL list while the card is mounted.
let _userLinks = [];
let _userCardBody = '';

async function addUserLink() {
  const input = document.getElementById('userLinkInput');
  const url = input?.value?.trim();
  if (!url) { showToast('Enter a URL first'); return; }
  if (!url.startsWith('http')) { showToast('URL must start with http'); return; }
  _userLinks = [..._userLinks, url];
  input.value = '';
  _refreshUserLinkChips(_userLinks);
  await _saveUserLinks();
}

async function removeUserLink(idx) {
  _userLinks = _userLinks.filter((_, i) => i !== idx);
  _refreshUserLinkChips(_userLinks);
  await _saveUserLinks();
}

async function _saveUserLinks() {
  const newBody = _serializeUserLinks(_userCardBody, _userLinks);
  _userCardBody = newBody;
  const res = await fetchJSON('/api/identity/section/user', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: newBody }),
  });
  if (res?.ok) showToast('Links saved');
  else showToast(res?.error || 'Saved locally — backend not ready');
}

// ===== Integrations =====

// Expected section labels — used for display and documentation.
// The actual labels come from /api/accounts/integration-cards section.label fields.
// "Foundation Models" | "Workspace" | "Productivity" | "Health"
const INTEGRATION_SECTION_LABELS = {
  foundation_models: 'Foundation Models',
  workspace:         'Workspace',
  productivity:      'Productivity',
  health:            'Health',
  finances:          'Finances',
};

// Inline test-result state per provider (cleared on reload)
const _keyTestResults = {};

// ── Integrations — unified table ──────────────────────────────────────────

const DATA_COLS = [
  { id: 'chat',        label: 'Chat',     icon: 'chat',           title: 'Chat history and transcripts' },
  { id: 'email',       label: 'Email',    icon: 'mail',           title: 'Email messages' },
  { id: 'contacts',    label: 'Contacts', icon: 'contacts',       title: 'Contacts and people records' },
  { id: 'calendar',    label: 'Calendar', icon: 'calendar_month', title: 'Calendar events' },
  { id: 'sms',         label: 'SMS',      icon: 'sms',            title: 'SMS and iMessage' },
  { id: 'photos',      label: 'Photos',   icon: 'photo_library',  title: 'Photos and media metadata' },
  { id: 'health',      label: 'Health',   icon: 'monitor_heart',  title: 'Health metrics and lab data points' },
  { id: 'other',       label: 'Other',    icon: 'more_horiz',     title: 'Other useful data and generated substrate' },
];
const INTEG_TOTAL_COLS = 2 + DATA_COLS.length + 4; // provider/account + counts + action/status/last/cost

const IMPORT_META = {
  anthropic:  { url: 'https://claude.ai/settings/privacy',                             label: 'Export ↗', tip: 'Claude.ai → Settings → Privacy → Export data → drop .json into ~/robotdojo/user/inbox/' },
  openai:     { url: 'https://chat.openai.com/#settings/DataControls',                 label: 'Export ↗', tip: 'ChatGPT → Settings → Data Controls → Export data → drop .zip into ~/robotdojo/user/inbox/' },
  google:     { url: 'https://takeout.google.com',                                      label: 'Takeout ↗', tip: 'Google Takeout → select Gmail, Calendar, Drive → drop .tgz into ~/robotdojo/user/inbox/' },
  microsoft:  { url: 'https://account.microsoft.com/privacy/download-data',             label: 'Export ↗', tip: 'Microsoft Privacy → Download your data → drop into ~/robotdojo/user/inbox/' },
  xai:        { url: 'https://x.com/settings/download_your_data',                       label: 'Export ↗', tip: 'X.com → Settings → Download your data → drop into ~/robotdojo/user/inbox/' },
  grok:       { url: 'https://x.com/settings/download_your_data',                       label: 'Export ↗', tip: 'X.com → Settings → Download your data → drop into ~/robotdojo/user/inbox/' },
  apple:      { url: null,   label: '—',         tip: 'iMessage & Contacts are read directly from your Mac — no export needed.' },
  ollama:     { url: null,   label: '—',         tip: 'Ollama runs locally — no export needed.' },
  notion:     { url: 'https://www.notion.so/help/export-your-content',                  label: 'Export ↗', tip: 'Notion → Settings → Export workspace → drop .zip into ~/robotdojo/user/inbox/' },
  granola:    { url: null,   label: '—',         tip: 'Install the free Granola app and sign in — transcripts import automatically. No API key needed.' },
};

// st_4e7e3aaf AC11 — Granola download link removed; Apple deep-link routed
// through /api/accounts/open-settings so no raw deeplink is exposed in the
// client. Keys retained so callers that look up LOCAL_AUTH_META still find
// the provider; url:null means the type column renders a non-link variant.
const LOCAL_AUTH_META = {
  apple:   { url: null, tip: 'Open macOS Privacy & Security → Full Disk Access via the modal.' },
  granola: { url: null, tip: 'Sign in to the Granola Mac app to connect.' },
};

const IMPORT_HELP_PROMPT = `Open the Robot Dojo Set Up Guide for importing data in the right order.

Cover:
1. LLM exports from ChatGPT, Claude, Gemini, and Grok. Include direct links to the provider export/settings pages.
2. Google: explain both Google Takeout and OAuth auth. Make clear OAuth imports in the background after auth.
3. Local MacBook data auth: explain macOS permissions for Contacts, Calendar, Messages, Photos, and Full Disk Access.
4. API-key integrations: explain that once the key is saved, Robot Dojo can import in the background where that provider supports it.

End by asking which import path I want to dig into first. If I name one, answer inline with the right provider link and the exact next action.`;

function _fmtCount(n) {
  if (!n) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return n.toLocaleString();
}

function _fmtAge(iso) {
  if (!iso) return null;
  const sec = (Date.now() - new Date(iso)) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function _fmtShortAge(iso) {
  if (!iso) return '-';
  const sec = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (sec < 60) return 'now';
  if (sec < 3600) return `${Math.round(sec / 60)} mins`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hrs`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)} days`;
  return new Date(iso).toLocaleDateString();
}

function toggleKeyInput(provider) {
  const row = document.getElementById(`keyInputRow_${provider}`);
  if (row) row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
}

function _providerImportLink(provider, email) {
  const meta = IMPORT_META[provider] || { label: '—', tip: '' };
  if (!meta.url) return `<span style="color:var(--muted);font-size:12px" title="${esc(meta.tip)}">${esc(meta.label)}</span>`;
  const href = (provider === 'google' || provider === 'microsoft') && email
    ? `${meta.url}?authuser=${encodeURIComponent(email)}`
    : meta.url;
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="integ-import-link" title="${esc(meta.tip)}">${esc(meta.label)}</a>`;
}

function _oauthConnectHref(provider, email = null, displayName = null) {
  const params = new URLSearchParams();
  if (email) params.set('login_hint', email);
  if (displayName) params.set('display_name', displayName);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  if (provider === 'google') {
    const account = email || 'personal';
    return `/api/auth/google/start?account=${encodeURIComponent(account)}`;
  }
  if (provider === 'microsoft') return `/account/integrations${suffix}`;
  return `/oauth/connect?vendor=${encodeURIComponent(provider)}${suffix ? `&${params.toString()}` : ''}`;
}

function _providerAddAccountHtml(provider) {
  if (provider === 'google') {
    return `<button type="button" class="integ-add-account-inline" onclick="openIntegrationAddAccount('google')" title="Add Google account">+ Add Account</button>`;
  }
  if (provider === 'microsoft') {
    return `<button type="button" class="integ-add-account-inline" onclick="openIntegrationAddAccount('microsoft')" title="Add Microsoft account">+ Add Account</button>`;
  }
  return '';
}

function _integrationStatusColor(status, lastSyncIso, connected = true, required = true) {
  const s = String(status || '').toLowerCase();
  let color = 'green';
  if (/failed|error|invalid_key|quota_exceeded|provider_error/.test(s)) color = 'red';
  else if (_isIntegrationInProgressState(s)) color = 'yellow';
  else if (/missing|needs|disconnected|not_configured/.test(s)) color = required ? 'red' : 'green';
  else if (!connected) color = required ? 'red' : 'green';
  return color;
}

function _integStatusCircle(connected, lastSyncIso, status = null, required = true) {
  // st_bf4978b0 — the legacy circle routes through the SAME _integrationBucket
  // as the modern renderer so the two can never diverge (AC1: both renderers,
  // three buckets). These legacy call sites carry no live-verification
  // timestamp, so this path reflects the honest bucket from (connected, status)
  // alone — it never fabricates a Healthy dot from a mere last_sync.
  const pseudo = { connected, state: status || (connected ? 'connected' : 'disconnected'), status, launch_required: required };
  const bucket = _integrationBucket(String(status || '').toLowerCase(), pseudo, pseudo, null, lastSyncIso);
  return `<span class="integ-status-circle integ-status-${bucket.color}" title="${esc(bucket.label)}" aria-label="${esc(bucket.hover)}"></span>`;
}

function _integCountCell(n, label = '') {
  const fmt = _fmtCount(n);
  return fmt
    ? `<td class="integ-td-count" data-label="${esc(label)}">${fmt}</td>`
    : `<td class="integ-td-count" data-label="${esc(label)}"><span class="integ-dash">-</span></td>`;
}

function _integKeyAuthCell(card) {
  const { provider, credential: cred = '', auth } = card;
  if (provider === 'apple' || provider === 'ollama') {
    return `<td class="integ-td-auth"><span class="integ-auth-local">${_deviceSlug || 'Mac-local'}</span></td>`;
  }
  if (provider === 'granola') {
    const badge = `<span class="integ-auth-local">${_deviceSlug || 'Mac-local'}</span>`;
    if (!card.connected) {
      // st_4e7e3aaf AC11 — Sign in opens the local Granola Mac app.
      return `<td class="integ-td-auth">${badge} <button type="button" class="acct-action-btn acct-reconnect-btn" title="Sign in to Granola" onclick="showGranolaSignInModal()">Sign in</button></td>`;
    }
    return `<td class="integ-td-auth">${badge}</td>`;
  }
  if (auth === 'api_key' || provider === 'notion') {
    const keyDisplay = cred ? `<span class="acct-credential">${esc(cred)}</span>` : '';
    const editBtn = `<button class="acct-action-btn acct-edit-btn" title="Edit key" onclick="toggleKeyInput('${esc(provider)}')"><span class="material-symbols-outlined icon-sm">edit</span></button>`;
    const testBtn = (cred && provider !== 'notion') ? `<button class="acct-action-btn" title="Test key" onclick="testProviderKey('${esc(provider)}')"><span class="material-symbols-outlined icon-sm">check_circle</span></button>` : '';
    const delBtn = cred ? `<button class="acct-action-btn acct-delete-btn" title="Remove key" onclick="removeProviderKey('${esc(provider)}')"><span class="material-symbols-outlined icon-sm">delete</span></button>` : '';
    const inputRow = `<div id="keyInputRow_${esc(provider)}" class="integ-key-input-row"><input id="keyInput_${esc(provider)}" type="password" placeholder="Paste key…" autocomplete="off" class="integ-key-input"><button class="acct-action-btn" onclick="saveProviderKey('${esc(provider)}')">Save</button></div>`;
    return `<td class="integ-td-auth">${keyDisplay}${editBtn}${testBtn}${delBtn}${inputRow}</td>`;
  }
  return `<td class="integ-td-auth"></td>`;
}

function _renderIntegCard(card, sectionId) {
  let rows = '';
  const { provider } = card;

  if (sectionId === 'workspace') {
    rows += `<tr class="integ-provider-row">
      <td class="integ-td-name integ-provider-name">${esc(card.name)}</td>
      ${DATA_COLS.map(() => `<td class="integ-td-count"></td>`).join('')}
      <td class="integ-td-auth"></td><td class="integ-td-import"></td><td class="integ-td-seed"></td><td class="integ-td-status"></td>
    </tr>`;

    if (provider === 'google' || provider === 'microsoft') {
      for (const acct of (card.accounts || [])) {
        const p = acct.products || {};
        const emailN = p.gmail || p.email || 0;
        const calN = p.calendar || 0;
        const contactN = p.contacts || 0;
        const isConn = provider === 'microsoft' ? !!acct.connected : emailN + calN > 0;
        const authUrl = _oauthConnectHref(provider, acct.email);
        // st_d142f701 AC2: when the OAuth refresh has surfaced an invalid_grant
        // (token revoked at the provider), the Keychain tokens are cleared
        // and accounts.status flips to 'needs_reauth'. Render an explicit
        // Reconnect CTA that takes the user back through the OAuth consent
        // screen. Without this, the row keeps showing "Authenticated" but
        // every sync silently fails.
        const needsReauth = acct.account_status === 'needs_reauth';
        const authCell = provider === 'microsoft'
          ? (needsReauth
              ? `<a href="${authUrl}" target="_blank" rel="noopener noreferrer" class="integ-authenticate-link integ-needs-reauth">Reconnect ↗</a>`
              : (isConn
                ? `<span class="integ-auth-connected">App credentials</span>`
                : `<button type="button" class="integ-add-account-inline" onclick="openIntegrationAddAccount('microsoft')">Set up app credentials</button>`))
          : (needsReauth
              ? `<a href="${authUrl}" target="_blank" rel="noopener noreferrer" class="integ-authenticate-link integ-needs-reauth">Reconnect ↗</a>`
              : (isConn
                ? `<span class="integ-auth-connected">Authenticated</span><a href="${authUrl}" target="_blank" rel="noopener noreferrer" class="acct-action-btn acct-reconnect-btn" title="Re-authenticate"><span class="material-symbols-outlined icon-sm">autorenew</span></a>`
                : `<a href="${authUrl}" target="_blank" rel="noopener noreferrer" class="integ-authenticate-link">Authenticate ↗</a>`));
        const counts = { chat: 0, email: emailN, calendar: calN, contacts: contactN, messages: 0, transcripts: 0 };
        rows += `<tr class="integ-account-row">
          <td class="integ-td-name integ-account-name">${esc(acct.email)}</td>
          ${DATA_COLS.map(c => _integCountCell(counts[c.id])).join('')}
          <td class="integ-td-auth">${authCell}</td>
          <td class="integ-td-import">${_providerImportLink(provider, acct.email)}</td>
          <td class="integ-td-seed">${_fmtAge(acct.last_sync) ?? '—'}</td>
          <td class="integ-td-status">${_integStatusCircle(isConn, acct.last_sync, acct.sync_state || acct.account_status, card.launch_required !== false)}</td>
        </tr>`;
      }
      rows += `<tr class="integ-connect-row"><td colspan="${INTEG_TOTAL_COLS}">${_providerAddAccountHtml(provider)}</td></tr>`;
    } else if (provider === 'apple') {
      const d = card.doc_counts || {};
      const imessageN = d.imessage || 0;
      const contactN = d.contacts || 0;
      const isConn = imessageN + contactN > 0;
      const counts = { chat: 0, email: 0, calendar: 0, contacts: contactN, messages: imessageN, transcripts: 0 };
      const statusColor = _integrationStatusColor(card.launch_state || card.status || (isConn ? 'connected' : 'disconnected'), card.last_sync, isConn, card.launch_required !== false);
      rows += `<tr class="integ-account-row">
        <td class="integ-td-name integ-account-name">${_deviceSlug || 'Mac-local'}${_providerAddAccountHtml('apple')}</td>
        ${DATA_COLS.map(c => _integCountCell(counts[c.id])).join('')}
        <td class="integ-td-auth"><span class="integ-auth-local">${_deviceSlug || 'Mac-local'}</span></td>
        <td class="integ-td-import"><span class="integ-dash">-</span></td>
        <td class="integ-td-seed">${_fmtAge(card.last_sync) ?? '—'}</td>
        <td class="integ-td-status"><div class="integ-status-compact">${_integStatusCircle(isConn, card.last_sync, card.launch_state || card.status, card.launch_required !== false)}</div></td>
      </tr>`;
      if (card.integration_error?.includes('Full Disk Access')) {
        rows += `<tr class="integ-account-row integ-error-row">
          <td class="integ-td-name integ-account-name" colspan="2" style="color:var(--error,#d32f2f);font-size:12px">iMessage: Full Disk Access required</td>
          <td colspan="${INTEG_TOTAL_COLS - 2}">
            <button class="acct-action-btn" onclick="openFullDiskAccessSettings()" style="font-size:12px;margin-right:12px">Open Privacy Settings</button>
            <button class="acct-action-btn" onclick="showAppleFdaModal()" style="font-size:12px">Show permission steps</button>
          </td>
        </tr>`;
      }
    }
    return rows;
  }

  // Foundation Models + Productivity — single provider row
  const docCount = card.doc_count || 0;
  const isConn = !!card.connected;
  const isHealthDataProvider = provider === 'apple-health' || provider === 'health-labs' || provider === 'oura';
  const counts = { chat: 0, email: 0, calendar: 0, contacts: 0, messages: 0, transcripts: provider === 'granola' ? docCount : 0, health: isHealthDataProvider ? docCount : 0, other: card.doc_counts?.files || 0 };
  const docCountUnit = isHealthDataProvider ? 'data points' : 'pages';
  const nameSuffix = (docCount && provider !== 'granola') ? ` <span style="color:var(--muted);font-size:11px">${_fmtCount(docCount)} ${docCountUnit}</span>` : '';
  rows += `<tr class="integ-provider-row">
    <td class="integ-td-name integ-provider-name">${esc(card.name)}${nameSuffix}</td>
    ${DATA_COLS.map(c => _integCountCell(counts[c.id])).join('')}
    ${_integKeyAuthCell(card)}
    <td class="integ-td-import">${_providerImportLink(provider, null)}</td>
    <td class="integ-td-seed">${_fmtAge(card.last_sync) ?? '—'}</td>
    <td class="integ-td-status">${_integStatusCircle(isConn, card.last_sync, card.launch_state || card.status, card.launch_required !== false)}</td>
  </tr>`;
  return rows;
}


async function renderIntegrations(renderCycle = _renderCycle) {
  _destroyIntegrationSortables();
  const feed = $('#accountsFeed');
  $('#accountsToolbar').innerHTML = `<span class="accounts-toolbar-title">Integrations</span>`;

  // st_4e7e3aaf AC5 — cache-first render. If the persisted cache has an
  // integration-cards payload, hydrate from it and paint immediately, then
  // kick off a background revalidation. Cold deep-links skip the spinner.
  if (!tabDataLoaded.integrations) {
    const cached = _readSectionCache('integrations');
    if (cached) {
      _integrationCards = cached;
      tabDataLoaded.integrations = true;
      updateSidebarCounts();
      // Fire-and-forget revalidation — re-renders if the payload changed.
      revalidateSectionInBackground('integrations').catch(() => { /* */ });
    }
  }

  if (!tabDataLoaded.integrations) {
    feed.innerHTML = `
      <p class="integ-summary">Integration data is loading. Counts and connection status will appear here.</p>
      <div class="acct-loading">Loading integrations...</div>`;
    const queryParams = new URLSearchParams(location.search);
    const forceRefresh = queryParams.get('refresh') === '1' || queryParams.has('connected') || queryParams.has('error');
    const loaded = await loadAccountTabState('integrations', async () => {
      const cardsUrl = `/api/accounts/integration-cards${forceRefresh ? '?refresh=1' : ''}`;
      const [acctsRes, vendorsRes, providersRes, secretsRes, healthRes, integCardsRes] = await Promise.allSettled([
        fetchJSON('/api/accounts'), fetchJSON('/api/accounts/vendors'),
        fetchJSON('/api/accounts/llm-providers'), fetchJSON('/api/accounts/secrets-status'),
        _silentFetchJSON('/api/integrations/health'),
        _silentFetchJSON(cardsUrl),
      ]);
      const value = (res, fallback) => res.status === 'fulfilled' ? (res.value ?? fallback) : fallback;
      return {
        accts: value(acctsRes, []),
        vendors: value(vendorsRes, {}),
        providers: value(providersRes, []),
        secrets: value(secretsRes, { secrets: {}, vendorSecrets: {} }),
        health: value(healthRes, null),
        integCards: value(integCardsRes, null),
      };
    }, { force: forceRefresh });
    const { accts, vendors, providers, secrets, health, integCards } = loaded || {};
    allAccounts = accts || [];
    allVendors = vendors || {};
    llmProviders = providers || [];
    secretsStatus = secrets || { secrets: {}, vendorSecrets: {} };
    _integrationHealth = {};
    for (const r of (health?.integrations || [])) _integrationHealth[r.name] = r;
    _integrationCards = integCards || null;
    window._integrationDashboard = null;
    tabDataLoaded.integrations = true;
    // st_4e7e3aaf AC5 — persist for next cold load.
    if (integCards) _writeSectionCache('integrations', integCards);
    hydrateIntegrationDeviceSlug();
    if (new URLSearchParams(location.search).has('connected') || new URLSearchParams(location.search).get('refresh') === '1') {
      history.replaceState({ tab: 'integrations' }, '', '/account/integrations');
    }
    updateSidebarCounts();
  }
  if (isStaleRender(renderCycle)) return;
  await loadAccountTopicLabels();
  const data = _integrationCards;
  if (!data) {
    feed.innerHTML = `
    <div class="accounts-empty">
      <span class="material-symbols-outlined accounts-empty-icon">electrical_services</span>
      <p>Couldn\u2019t load integrations</p>
      <p class="accounts-empty-hint"><button type="button" class="acct-form-submit" onclick="invalidateIntegrationsState();renderIntegrations()">Retry</button></p>
    </div>`;
    return;
  }

  const connected = data.connected ?? 0;
  const total_artifacts = data.total_artifacts ?? 0;
  const freshness = data.count_snapshot?.updatedAt || window._integrationDashboard?.updatedAt || null;
  // AC7 (st_4e7e3aaf) — Counts-updated freshness line removed from the summary.
  const summaryHtml = `<p class="integ-summary">You have <strong>${connected}</strong> connected integration${connected !== 1 ? 's' : ''} and <strong>${_fmtCount(total_artifacts) ?? '0'}</strong> source records available to Robot Dojo.</p>`;

  feed.innerHTML = `
    ${summaryHtml}
    ${_renderMailboxTopics()}
    ${_renderGroupedIntegrations(data)}
    <div class="integ-explain-row">
      <a href="/chat?prompt=${encodeURIComponent(IMPORT_HELP_PROMPT)}&context=setup-guide&autosend=true" target="_blank" rel="noopener noreferrer" class="integ-explain-link">Set Up Guide</a>
    </div>`;
  _initIntegrationSortables();
  handleIntegrationKeyDeepLink();
}

function _mailboxAccounts() {
  const rows = (window._mailboxes && window._mailboxes.length)
    ? window._mailboxes
    : (Array.isArray(allAccounts) ? allAccounts : []);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = String(row.email || '').trim();
    if (!email.includes('@') || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(row);
  }
  return out.sort((a, b) => String(a.email).localeCompare(String(b.email)));
}

function _topicOptions(selected) {
  const labels = window._accountTopicLabels || [];
  const opts = ['<option value="">No topic</option>'];
  for (const label of labels) {
    const slug = label.slug || label.context || '';
    if (!slug) continue;
    const on = slug === selected ? ' selected' : '';
    opts.push(`<option value="${esc(slug)}"${on}>${esc(label.name || slug)}</option>`);
  }
  return opts.join('');
}

function _renderMailboxTopics() {
  const boxes = _mailboxAccounts();
  if (!boxes.length) return '';
  const rows = boxes.map((row) => `
    <tr>
      <td>${esc(row.email)}</td>
      <td>${esc(row.vendor || row.provider || '')}</td>
      <td>
        <select class="acct-topic-select" data-account-id="${esc(row.id)}" onchange="setMailboxTopic(this)">
          ${_topicOptions(row.topic_slug || '')}
        </select>
      </td>
    </tr>`).join('');
  return `
    <section class="integ-mailboxes">
      <h3>Mailbox topics</h3>
      <p class="integ-muted">Mail from a connected account uses this topic. Domain matches (Prism, Staircase, and the rest) still apply inside a personal inbox.</p>
      <table class="integ-mailbox-table">
        <thead><tr><th>Mailbox</th><th>Source</th><th>Topic</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

async function loadAccountTopicLabels() {
  if (!window._accountTopicLabels) {
    const data = await fetchJSON('/api/labels').catch(() => null);
    window._accountTopicLabels = data?.labels || [];
  }
  if (!window._mailboxes) {
    const boxes = await fetchJSON('/api/accounts/mailboxes').catch(() => null);
    window._mailboxes = boxes?.mailboxes || [];
  }
}

window.setMailboxTopic = async function setMailboxTopic(el) {
  const id = el?.dataset?.accountId;
  if (!id) return;
  const res = await fetchJSON(`/api/accounts/${encodeURIComponent(id)}/topic`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic_slug: el.value || '' }),
  });
  if (!res?.ok) {
    showToast(res?.error || 'Could not save topic');
    return;
  }
  const email = String(res.email || '').toLowerCase();
  for (const row of allAccounts || []) {
    if (String(row.email || '').toLowerCase() === email) row.topic_slug = res.topic_slug;
  }
  showToast('Topic saved');
};

function handleIntegrationKeyDeepLink() {
  const provider = pendingIntegrationKeyProvider;
  if (!provider || activeSection !== 'integrations') return;
  pendingIntegrationKeyProvider = '';
  const row = document.querySelector(`.integ-row[data-provider="${CSS.escape(provider)}"], .integ-provider-row[data-provider="${CSS.escape(provider)}"]`);
  row?.scrollIntoView?.({ block: 'center' });
  openProviderKeyModal(provider);
}

async function hydrateIntegrationDeviceSlug() {
  if (_deviceSlug) return;
  const deviceData = await fetchJSON('/api/identity/device-name').catch(() => null);
  if (!deviceData?.slug || _deviceSlug === deviceData.slug) return;
  _deviceSlug = deviceData.slug;
  if (activeSection === 'integrations' && tabDataLoaded.integrations) {
    renderIntegrations();
  }
}

async function renderRemoteAccess() {
  return renderGeneral();
}

// st_d9fc573b — Display labels for the substrate_type column.
const SUBSTRATE_LABELS = {
  oauth: 'OAuth', api_key: 'API key', app_credentials: 'App credentials', local: 'Local', host: 'Host', webhook: 'Webhook',
};

const INTEGRATION_STATE_LABELS = {
  connected: 'connected',
  ready: 'ready',
  needs_key: 'needs key',
  needs_oauth: 'needs sign-in',
  needs_reauth: 'needs reconnect',
  needs_permission: 'needs permission',
  importing: 'importing',
  queued: 'queued',
  running: 'running',
  pending: 'pending',
  paused: 'paused',
  partial: 'partial',
  limited: 'limited',
  stale: 'stale',
  failed: 'failed',
  error: 'problem',
  done: 'done',
  error_recoverable: 'needs attention',
  invalid_key: 'invalid key',
  quota_exceeded: 'quota exceeded',
  provider_error: 'provider unavailable',
  no_probe: 'not tested',
  no_key: 'needs key',
};

const INTEGRATION_IN_PROGRESS_STATE_RE = /queued|running|importing|paused|pending|partial|limited|stale|no_probe/;

function _isIntegrationInProgressState(status) {
  return INTEGRATION_IN_PROGRESS_STATE_RE.test(String(status || '').toLowerCase());
}

const CREDENTIAL_STATE_LABELS = {
  stored: 'key stored',
  missing: 'missing',
  signed_in: 'signed in',
  not_connected: 'not connected',
  needs_permission: 'needs permission',
  available: 'available',
  ready: 'ready',
  not_configured: 'not configured',
};

const ARTIFACT_LABELS = {
  email: 'Email',
  calendar: 'Cal',
  contacts: 'Contacts',
  documents: 'Docs',
  sheets: 'Sheets',
  slides: 'Slides',
  photos: 'Photos',
  messages: 'Messages',
  transcripts: 'Transcripts',
  tasks: 'Tasks',
  health: 'Health',
  search_console: 'Search',
};

function _artifactSummary(card) {
  const counts = card.artifact_counts_by_type || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return '<span class="integ-muted">No records yet</span>';
  return entries
    .sort(([a], [b]) => (ARTIFACT_LABELS[a] || a).localeCompare(ARTIFACT_LABELS[b] || b))
    .map(([key, n]) => `<span class="integ-data-pill">${esc(ARTIFACT_LABELS[key] || key)} ${esc(_fmtCount(Number(n)) || String(n))}</span>`)
    .join('');
}

function _credentialLabel(card) {
  const state = card.credential_state || (card.connected ? 'available' : 'not_configured');
  return CREDENTIAL_STATE_LABELS[state] || state.replace(/_/g, ' ');
}

// st_d9fc573b — One uniform row per integration card. Columns:
// identity | type | data | status | credential | last_seen | action.
function _renderIntegRow(card) {
  const provider = card.provider || '';
  const sectionIcon = TYPE_ICONS[card.type] || (card.section === 'foundation_models' || card._section === 'foundation_models' ? 'smart_toy' : 'extension');
  const substrateLabel = SUBSTRATE_LABELS[card.substrate_type] || card.substrate_type || card.auth || '—';
  const status = card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'needs_key');
  const statusLabel = INTEGRATION_STATE_LABELS[status] || status;
  const inProgress = _isIntegrationInProgressState(status);
  const statusIcon = status === 'connected' || status === 'ready' || status === 'done' ? 'check_circle'
    : inProgress ? 'hourglass_top'
      : 'error';
  const statusClass = status === 'connected' || status === 'ready' || status === 'done' ? 'integ-status-ok'
    : inProgress ? 'integ-status-warn'
      : 'integ-status-off';
  const statusTone = statusClass === 'integ-status-ok' ? 'ok' : statusClass === 'integ-status-warn' ? 'warn' : 'off';
  const statusHtml = appComponents().statusPill
    ? appComponents().statusPill(statusLabel, statusTone)
    : `<span class="${statusClass}" title="${esc(recovery)}"><span class="material-symbols-outlined icon-sm">${statusIcon}</span> ${esc(statusLabel)}</span>`;
  const lastSync = card.last_seen_at || card.last_sync_at || card.last_sync;
  const lastSyncStr = lastSync
    ? (_fmtAge(lastSync) || lastSync)
    : (typeof card.spend_30d_usd === 'number' && card.spend_30d_usd > 0 ? `$${card.spend_30d_usd.toFixed(2)} / 30d` : '—');
  const recovery = card.recovery || '';
  const action = card.primary_action || null;
  let actionHtml = '';
  if (action?.kind === 'oauth' || (card.substrate_type === 'oauth' && ['needs_oauth', 'failed', 'error_recoverable'].includes(status))) {
    const href = action?.href || (provider === 'google'
      ? '/api/auth/google/start?account=personal'
      : `/oauth/connect?vendor=${encodeURIComponent(provider)}`);
    actionHtml = `<a class="acct-action-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(recovery || 'Connect account')}"><span class="material-symbols-outlined icon-sm">add_link</span> Connect</a>`;
  } else if (action?.kind === 'add_account') {
    actionHtml = `<button class="acct-action-btn" onclick="openIntegrationAddAccount('${esc(provider)}')" title="${esc(recovery || 'Add account')}"><span class="material-symbols-outlined icon-sm">add</span> Add Account</button>`;
  } else if (action?.kind === 'add_key' || (card.substrate_type === 'api_key' && status !== 'connected')) {
    actionHtml = `<button class="acct-action-btn" onclick="showAddForm('${esc(provider)}')" title="${esc(recovery || 'Paste key')}"><span class="material-symbols-outlined icon-sm">key</span> Add key</button>`;
  } else if (action?.kind === 'disconnect_key' || (card.substrate_type === 'api_key' && status === 'connected')) {
    actionHtml = `<button class="acct-action-btn" onclick="removeProviderKey('${esc(provider)}')" title="Disconnect"><span class="material-symbols-outlined icon-sm">link_off</span></button>`;
  } else {
    actionHtml = recovery
      ? `<span class="integ-action-hint" title="${esc(recovery)}">${esc(action?.label || statusLabel)}</span>`
      : '<span class="integ-action-hint">—</span>';
  }
  const identity = card.provider_identity || {};
  const name = identity.name || card.name || provider;
  const account = identity.account || '';
  return `<tr class="integ-row" data-provider="${esc(provider)}" data-substrate-type="${esc(card.substrate_type || '')}" data-status="${esc(status)}">
    <td data-label="" data-col="icon" class="integ-td-icon"><span class="material-symbols-outlined">${esc(sectionIcon)}</span></td>
    <td data-label="Integration" data-col="name" class="integ-td-name">${esc(name)}${account ? `<div class="integ-row-sub">${esc(account)}</div>` : ''}${card.launch_required ? ' <span class="integ-required" title="Required for first-session launch">required</span>' : ''}</td>
    <td data-label="Type" data-col="type" class="integ-td-type">${esc(substrateLabel)}</td>
    <td data-label="Data" data-col="data" class="integ-td-data">${_artifactSummary(card)}</td>
    <td data-label="Status" data-col="status" class="integ-td-status">${statusHtml}</td>
    <td data-label="Credential" data-col="credential" class="integ-td-credential">${esc(_credentialLabel(card))}</td>
    <td data-label="Updated" data-col="last_sync" class="integ-td-last-sync">${esc(lastSyncStr)}</td>
    <td data-label="Action" data-col="action" class="integ-td-action">${actionHtml}</td>
  </tr>`;
}

function _countColumnsFromCounts(counts = {}) {
  const chat = Number(counts.chat || 0) + Number(counts.transcripts || 0);
  const email = Number(counts.email || counts.gmail || 0);
  const contacts = Number(counts.contacts || 0);
  const calendar = Number(counts.calendar || 0);
  const sms = Number(counts.sms || counts.messages || counts.imessage || 0);
  const photos = Number(counts.photos || 0);
  const health = Number(counts.health || 0);
  const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { chat, email, contacts, calendar, sms, photos, health, other: Math.max(0, total - chat - email - contacts - calendar - sms - photos - health) };
}

function _renderCountTds(counts = {}) {
  const normalized = _countColumnsFromCounts(counts);
  return DATA_COLS.map((c) => _integCountCell(normalized[c.id], c.label)).join('');
}

function _renderBlankCountTds() {
  return DATA_COLS.map((c) => `<td class="integ-td-count integ-td-empty" data-label="${esc(c.label)}"></td>`).join('');
}

function _integrationActionHtml(card) {
  const provider = card.provider || '';
  const status = card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'ready');
  const substrate = card.substrate_type || card.auth || '';
  const action = card.primary_action || {};
  if (substrate === 'oauth' || action.kind === 'oauth') {
    const href = action.href || (provider === 'google'
      ? '/api/auth/google/start?account=personal'
      : `/oauth/connect?vendor=${encodeURIComponent(provider)}`);
    return `<a class="acct-action-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="material-symbols-outlined icon-sm">add_link</span> Auth</a>`;
  }
  if (action.kind === 'add_account' || substrate === 'app_credentials') {
    return `<button class="acct-action-btn" onclick="openIntegrationAddAccount('${esc(provider)}')"><span class="material-symbols-outlined icon-sm">add</span> Add Account</button>`;
  }
  if (substrate === 'api_key' || card.auth === 'api_key') {
    const connected = status === 'connected' || card.connected;
    return `<button class="acct-action-btn icon-only" title="${connected ? 'Edit key' : 'Add key'}" onclick="openProviderKeyModal('${esc(provider)}')"><span class="material-symbols-outlined icon-sm">edit</span></button>`;
  }
  return `<span class="integ-action-hint">${esc(action.label || (card.connected ? 'Ready' : '—'))}</span>`;
}

function _stateText(card) {
  const status = card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'ready');
  return INTEGRATION_STATE_LABELS[status] || String(status).replace(/_/g, ' ');
}

function _integrationStateKey(status) {
  return String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── st_bf4978b0 — the single status classifier ──────────────────────────────
// Every status dot in BOTH renderers (_integrationStatusDot/_integrationHealthHtml
// and the legacy _integStatusCircle) derives from _integrationBucket and NOWHERE
// else, so the two renderers cannot diverge. Exactly three buckets:
//   healthy (green) — a live connection VERIFIED working inside its freshness
//                     window; earned via `verified_at`, never defaulted.
//   imported (grey) — a one-time import; nothing live to check.
//   issue    (red)  — everything else: a failed check (immediately, no grace),
//                     a stale-past-window verification, or a never-verified one.
// This MIRRORS lib/integration-status.js (the Node-side guard/backend copy) —
// the two MUST stay in lockstep. The frontend can't import lib (raw browser
// script, no bundler); scripts/check-integration-truth.js asserts both renderers
// route through _integrationBucket so the pair can never silently drift.
const _INTEG_MIN = 60 * 1000;
const _INTEG_STALE_WINDOW_MS = {
  model_key: 60 * _INTEG_MIN,   // anthropic, openai, google(-ai), xai
  oauth: 180 * _INTEG_MIN,      // gmail, calendar, drive, outlook, microsoft
  other_key: 120 * _INTEG_MIN,  // notion, oura, asana, …
  local: 120 * _INTEG_MIN,      // imessage, apple-health (fallback; 2× cadence)
  default: 120 * _INTEG_MIN,
};
const _INTEG_MODEL_KEY_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'google-ai', 'xai']);
const _INTEG_OAUTH_PREFIXES = new Set(['gmail', 'calendar', 'drive', 'contacts', 'photos', 'microsoft', 'microsoft-mail', 'microsoft-calendar', 'outlook']);
const _INTEG_OTHER_KEY_PROVIDERS = new Set(['notion', 'oura', 'asana', 'asana_secondary', 'slab', 'hunter', 'brave', 'github', 'elevenlabs']);
const _INTEG_LOCAL_PREFIXES = new Set(['imessage', 'apple', 'apple-photos', 'apple-health', 'local']);
const _INTEG_FAILED_STATUSES = new Set(['failed', 'error', 'invalid_key', 'quota_exceeded', 'provider_error', 'needs_reauth', 'needs_permission', 'permission_denied']);

function _integStaleWindowMs(name, row, card) {
  const raw = String(name || '').toLowerCase();
  const base = raw.split(':')[0];
  const substrate = String(row?.type || card?.substrate_type || card?.auth || '').toLowerCase();
  // A per-account OAuth/local health name carries a prefix:scope; classify by it.
  if (raw.includes(':')) {
    if (_INTEG_OAUTH_PREFIXES.has(base)) return _INTEG_STALE_WINDOW_MS.oauth;
    if (_INTEG_LOCAL_PREFIXES.has(base)) return _INTEG_STALE_WINDOW_MS.local;
  }
  if (substrate === 'oauth' || row?.isNestedAccount) return _INTEG_STALE_WINDOW_MS.oauth;
  if (substrate === 'local' || _INTEG_LOCAL_PREFIXES.has(base)) return _INTEG_STALE_WINDOW_MS.local;
  if (_INTEG_MODEL_KEY_PROVIDERS.has(base)) return _INTEG_STALE_WINDOW_MS.model_key;
  if (_INTEG_OAUTH_PREFIXES.has(base)) return _INTEG_STALE_WINDOW_MS.oauth;
  if (_INTEG_OTHER_KEY_PROVIDERS.has(base)) return _INTEG_STALE_WINDOW_MS.other_key;
  return _INTEG_STALE_WINDOW_MS.default;
}

// The live-verification timestamp the dot reads to earn Healthy — distinct from
// last_check (probe-run) and last_sync (content-arrival). Mirrors the old
// _integrationCheckAt reader but for verified_at.
function _integrationVerifiedAt(row, card) {
  return row?.verifiedAt || row?.verified_at || card?.verified_at || null;
}

function _integrationBucketName(row, card) {
  return String(row?.name || card?.provider || row?.provider || '').toLowerCase();
}

// Punchy present-tense Issue hovers (5–8 words), by cause.
function _integIssueHover(status) {
  if (status === 'invalid_key' || status === 'bad_key') return 'Key rejected, reconnect to fix it';
  if (status === 'needs_reauth' || status === 'needs_oauth' || status === 'needs_sign_in') return 'Access expired, reconnect this account';
  if (status === 'needs_permission' || status === 'permission_denied') return 'Permission needed, re-grant disk access';
  if (status === 'quota_exceeded') return 'Quota reached, waiting on the provider';
  if (status === 'needs_key' || status === 'no_key' || status === 'not_configured' || status === 'missing' || status === 'disconnected') return 'No key saved yet, add one to connect';
  return 'Not verified recently, checking the connection';
}

// The one derivation. Returns { bucket, color, label, hover }.
function _integrationBucket(name, row, card, verifiedAt, lastSync) {
  const status = _integrationStateKey(
    row?.health_state || row?.state || card?.health_state
    || card?.connection_status || card?.launch_state || card?.status
    || ((row?.connected ?? card?.connected) ? 'connected' : 'ready'),
  );
  const explicitColor = String(row?.health_color || card?.health_color || '').toLowerCase();
  const oneTimeImport = row?.one_time_import || card?.one_time_import
    || card?.provider === 'imports'
    || card?.provider === 'health-labs'
    || status === 'one_time_import';

  // Imported — a one-time import; nothing live to verify.
  // Optional local models that are not running use the same grey bucket with an Off label.
  const provider = String(card?.provider || row?.provider || name || '').toLowerCase();
  const substrate = String(card?.substrate_type || card?.auth || row?.type || '').toLowerCase();
  if (oneTimeImport || explicitColor === 'grey') {
    if (provider === 'ollama') {
      return { bucket: 'imported', color: 'grey', label: 'Off', hover: 'Optional local model, not running' };
    }
    return { bucket: 'imported', color: 'grey', label: 'Imported', hover: 'Imported once, no live connection to check' };
  }
  // First-party Robot Dojo Chat: this page existing is the live check.
  if (substrate === 'first-party' || substrate === 'first_party' || provider.startsWith('robotdojo')) {
    return { bucket: 'healthy', color: 'green', label: 'Healthy', hover: 'This Mac is serving Chat' };
  }
  // Issue immediately — a failed check is a real break, no grace window. This
  // also kills the last-sync-outlives-failed-status lie: a failed row is Issue
  // and its hover names the failure, never a stale positive "updated".
  if (_INTEG_FAILED_STATUSES.has(status)) {
    return { bucket: 'issue', color: 'red', label: 'Issue', hover: _integIssueHover(status) };
  }
  // Issue — unconfigured / not-connected states collapse here too.
  if (/^(needs_key|no_key|needs_oauth|needs_sign_in|not_configured|disconnected|missing)$/.test(status)) {
    return { bucket: 'issue', color: 'red', label: 'Issue', hover: _integIssueHover(status) };
  }
  // Healthy — success status AND a live verification inside the per-class window.
  const successStatus = /^(ok|done|connected|active|partial|healthy)$/.test(status)
    || (row?.connected ?? card?.connected);
  const verifiedMs = verifiedAt ? Date.parse(verifiedAt) : NaN;
  const fresh = Number.isFinite(verifiedMs) && (Date.now() - verifiedMs) < _integStaleWindowMs(name, row, card);
  if (successStatus && fresh) {
    return { bucket: 'healthy', color: 'green', label: 'Healthy', hover: `Verified live ${_fmtAge(verifiedAt) || 'moments'} ago, connection working` };
  }
  // Otherwise Issue — stale-past-window or never-verified; the hover distinguishes.
  return {
    bucket: 'issue', color: 'red', label: 'Issue',
    hover: Number.isFinite(verifiedMs) ? 'Not verified recently, checking the connection' : 'Not verified yet, checking it now',
  };
}

// st_4e7e3aaf AC8 / st_bf4978b0 — status dot routes through the shared
// _integrationBucket classifier so raw snake_case status values never reach the
// DOM and the three-bucket truth is derived in exactly one place.
function _integrationStatusDot(row, card, last) {
  const bucket = _integrationBucket(_integrationBucketName(row, card), row, card, _integrationVerifiedAt(row, card), last);
  const html = `<span class="integ-status-dot integ-status-${bucket.color}" title="${esc(bucket.hover)}" aria-label="${esc(bucket.hover)}"></span>`;
  return { html, color: bucket.color, label: bucket.label, hover: bucket.hover, bucket: bucket.bucket };
}

function _integrationHealthHtml(row, card, last) {
  if (row.isProviderParent) return '<span class="integ-dash"></span>';
  const dot = _integrationStatusDot(row, card, last);
  // Always-visible three-bucket label under the dot; the punchy 5–8-word hover
  // is the single present-tense clause from the classifier (title + aria-label).
  return `<div class="integ-health-cell" title="${esc(dot.hover)}" aria-label="${esc(dot.hover)}">${dot.html}<span class="integ-status-label integ-status-label-${esc(dot.color)}">${esc(dot.label)}</span></div>`;
}

function _integrationTypeHtml(row, card) {
  const type = row.type || card.substrate_type || card.auth || 'local';
  const label = SUBSTRATE_LABELS[type] || String(type).replace(/_/g, ' ');
  const substrate = card.substrate_type || card.auth || type;
  if (row.isProviderParent && (substrate === 'oauth' || card.auth === 'oauth')) {
    return '<div class="integ-type-main">-</div>';
  }
  if (card.provider === 'ollama' || substrate === 'local') {
    if (card.provider === 'granola') {
      // st_4e7e3aaf AC11 — Sign in opens the Granola Mac app via
      // /api/accounts/open-app. Download link and /auth/granola click-through
      // removed: connection is auto-detected the moment Granola is signed in.
      const connected = row.connected ?? card.connected;
      const primary = connected
        ? ''
        : `<button type="button" class="acct-action-btn" onclick="showGranolaSignInModal()" title="Sign in to Granola"><span class="material-symbols-outlined icon-sm">add_link</span> Sign in</button>`;
      return `<div class="integ-type-main">Local app</div>${primary ? `<div class="integ-type-actions">${primary}</div>` : ''}`;
    }
    if (card.provider === 'apple') {
      return `<button type="button" class="integ-type-main integ-oauth-link" onclick="openIntegrationAddAccount('apple')" title="Grant Apple data access">Auth</button>`;
    }
    if (card.provider === 'apple-health') {
      return `<div class="integ-type-main">Daily file</div>`;
    }
    if (card.provider === 'health-labs') {
      return `<div class="integ-type-main">Import file</div>`;
    }
    if (card.provider === 'imports') {
      return `<div class="integ-type-main">Import files</div>`;
    }
    const local = LOCAL_AUTH_META[card.provider] || LOCAL_AUTH_META[row.provider];
    if (local?.url) return `<a class="integ-type-main integ-oauth-link" href="${esc(local.url)}" target="_blank" rel="noopener noreferrer" title="${esc(local.tip)}">Auth</a>`;
    return `<div class="integ-type-main">-</div>`;
  }
  if (substrate === 'api_key' || card.auth === 'api_key') {
    if (row.isProviderParent && Array.isArray(card.accounts)) {
      return '<div class="integ-type-main">-</div>';
    }
    const providerForAction = row.accountProvider || row.provider || card.provider;
    const connectedForAction = row.connected ?? card.connected;
    const cred = row.credential || card.credential || '';
    const keyDisplay = cred
      ? `<span class="acct-credential">${esc(formatCredential(cred))}</span>`
      : '';
    const actionCard = { ...card, provider: providerForAction, connected: connectedForAction, credential: cred, substrate_type: substrate, primary_action: connectedForAction ? { kind: 'disconnect_key', label: 'Remove key' } : { kind: 'add_key', label: 'Add key' } };
    return `<div class="integ-type-main">${esc(label)}</div><div class="integ-type-credential">${keyDisplay}<span class="integ-type-actions">${_integrationActionHtml(actionCard)}</span></div>`;
  }
  if (substrate === 'oauth' || card.auth === 'oauth') {
    const action = card.primary_action || {};
    const provider = card.provider || '';
    const accountEmail = row.account || card.provider_identity?.account || null;
    const href = provider === 'google' && accountEmail
      ? _oauthConnectHref(provider, accountEmail)
      : (action.href || _oauthConnectHref(provider, accountEmail));
    return `<a class="integ-type-main integ-oauth-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  if (substrate === 'app_credentials') {
    return `<div class="integ-type-main">${esc(label)}</div>`;
  }
  return `<div class="integ-type-main">${esc(label)}</div>`;
}

function _renderDashboardRow(row, groupId) {
  const card = row.card || row;
  const last = row.lastSeenAt || card.last_seen_at || card.last_sync_at || card.last_sync || null;
  const provider = row.provider || card.provider || '';
  const isNested = !!row.isNestedAccount;
  const isProviderParent = !!row.isProviderParent;
  const account = isProviderParent ? '' : (row.account || card.provider_identity?.account || '');
  const providerLabel = isNested ? account : (row.label || card.name || card.provider || 'Integration');
  const rowId = isNested
    ? `${provider}:${String(account || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'}`
    : provider;
  const addAccountHtml = groupId === 'workspace' && !isNested && ['google', 'microsoft'].includes(provider)
    ? `<div class="integ-row-sub">${_providerAddAccountHtml(provider)}</div>`
    : '';
  const accountProvider = row.accountProvider || provider;
  const isProviderSortable = row.sortMode === 'provider';
  const isAccountSortable = row.sortMode === 'account';
  const dragHandle = isProviderSortable
    ? `<span class="material-symbols-outlined integ-sort-handle integ-provider-drag-handle" title="Drag to reorder provider">drag_indicator</span>`
    : (isAccountSortable
      ? `<span class="material-symbols-outlined integ-sort-handle integ-account-drag-handle" title="Drag to reorder account">drag_indicator</span>`
      : '');
  const nameHtml = `<div class="integ-name-cell">${dragHandle}<span class="integ-name-main">${esc(providerLabel)}${account && !isNested ? `<div class="integ-row-sub">${esc(account)}</div>` : ''}${addAccountHtml}</span></div>`;
  const countCells = isProviderParent ? _renderBlankCountTds() : _renderCountTds(row.counts || card.artifact_counts_by_type || {});
  return `<tr class="integ-row${isNested ? ' integ-account-nested' : ''}${isProviderParent ? ' integ-provider-parent' : ''}${isAccountSortable ? ' integ-sort-account' : ''}" data-provider="${esc(provider)}" data-account-provider="${esc(accountProvider)}" data-integration-row="${esc(rowId)}" data-group="${esc(groupId)}" data-sort-key="${esc(row.sortKey || '')}" data-sort-mode="${esc(row.sortMode || '')}">
    <td class="integ-td-name" data-label="Provider">${nameHtml}</td>
    <td class="integ-td-type" data-label="Type">${_integrationTypeHtml(row, card)}</td>
    ${countCells}
    <td class="integ-td-status" data-label="Health">${_integrationHealthHtml(row, card, last)}</td>
  </tr>`;
}

function _robotDojoRows(data) {
  const rows = data.robot_dojo?.rows || [];
  return rows.map((r) => {
    const state = r.state || 'ready';
    return {
      ...r,
      lastSeenAt: r.lastSeenAt || r.last_seen_at || null,
      verifiedAt: r.verifiedAt || r.verified_at || null,
      recovery: r.recovery || '',
      card: {
        provider: r.provider,
        name: r.label,
        substrate_type: 'first-party',
        connected: state !== 'failed',
        launch_state: state === 'ready' ? 'connected' : state,
        status: state === 'ready' ? 'connected' : state,
        verified_at: r.verifiedAt || r.verified_at || null,
        recovery: r.recovery || '',
      },
    };
  });
}

function _sectionRows(section) {
  const rows = [];
  const sectionId = section.id || '';
  for (const card of (section.cards || [])) {
    const providerSortKey = _integrationProviderSortKey(card);
    const providerSortable = PROVIDER_SORTABLE_INTEGRATION_SECTIONS.has(sectionId);
    const accountSortable = ACCOUNT_SORTABLE_INTEGRATION_SECTIONS.has(sectionId)
      && Array.isArray(card.accounts)
      && card.accounts.length > 1;
    const canRenderNestedAccounts = sectionId !== 'foundation_models'
      && Array.isArray(card.accounts)
      && card.accounts.length;
    const shouldRenderProviderParent = canRenderNestedAccounts
      || (sectionId === 'workspace' && ['google', 'microsoft'].includes(card.provider));
    if (shouldRenderProviderParent) {
      rows.push({
        provider: card.provider,
        label: card.name || card.provider,
        type: card.substrate_type || card.auth || '',
        account: '',
        counts: {},
        state: card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'needs sign-in'),
        lastSeenAt: card.last_seen_at || card.last_sync_at || card.last_sync,
        lastCheckAt: card.last_check_at || card.last_check || null,
        verifiedAt: card.verified_at || null,
        spend30dUsd: card.spend_30d_usd,
        card,
        isProviderParent: true,
        sortMode: providerSortable ? 'provider' : '',
        sortKey: providerSortKey,
      });
      for (const acct of card.accounts) {
        const p = acct.products || {};
        const accountStatus = acct.account_status || '';
        const accountStatusKey = _integrationStateKey(accountStatus);
        const accountState = accountStatusKey === 'needs_reauth' || accountStatusKey === 'error'
          ? accountStatus
          : (acct.sync_state || accountStatus || card.launch_state || card.status || (card.connected ? 'connected' : 'needs sign-in'));
        rows.push({
          provider: card.provider,
          accountProvider: acct.provider || card.provider,
          label: '',
          type: acct.substrate_type || card.substrate_type || card.auth || 'oauth',
          account: acct.label || acct.email || acct.name,
          counts: { chat: p.chat || p.llm || 0, email: p.gmail || p.email || 0, contacts: p.contacts || 0, calendar: p.calendar || 0, sms: p.sms || p.messages || 0, photos: p.photos || 0, other: (p.drive || 0) + (p.docs || 0) + (p.tasks || 0) + (p.pages || 0) + (p.other || 0) },
          state: accountState,
          health_color: acct.health_color || null,
          health_state: acct.health_state || null,
          one_time_import: acct.one_time_import || card.one_time_import || false,
          stale_sensitive: acct.stale_sensitive ?? card.stale_sensitive,
          last_error: acct.last_error || card.last_error || card.integration_error || '',
          account_status: accountStatus,
          recovery: acct.recovery || card.recovery || '',
          lastSeenAt: acct.last_sync || card.last_sync_at || card.last_sync,
          lastCheckAt: acct.last_check || acct.last_check_at || card.last_check_at || card.last_check || null,
          verifiedAt: acct.verified_at || card.verified_at || null,
          spend30dUsd: card.spend_30d_usd,
          auth: acct.auth || card.auth,
          connected: acct.connected,
          credential: acct.credential,
          card,
          isNestedAccount: true,
          sortMode: accountSortable ? 'account' : '',
          sortKey: _integrationAccountSortKey(acct),
          sortScope: `${sectionId}:${providerSortKey}`,
        });
      }
      continue;
    }
    rows.push({
      card,
      provider: card.provider,
      label: card.name,
      type: card.substrate_type || card.auth || '',
      counts: card.artifact_counts_by_type || {},
      state: card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'ready'),
      health_color: card.health_color || null,
      health_state: card.health_state || null,
      one_time_import: card.one_time_import || false,
      stale_sensitive: card.stale_sensitive,
      lastSeenAt: card.last_seen_at || card.last_sync_at || card.last_sync,
      lastCheckAt: card.last_check_at || card.last_check || null,
      verifiedAt: card.verified_at || null,
      spend30dUsd: card.spend_30d_usd,
      sortMode: providerSortable ? 'provider' : '',
      sortKey: providerSortKey,
    });
  }
  return rows;
}

function _integrationRowBlocks(rows, groupId) {
  const blocks = [];
  let current = null;
  for (const row of rows || []) {
    if (!row.isNestedAccount || !current) {
      current = {
        rows: [row],
        sortKey: row.sortKey || row.provider || row.label || '',
        isProviderSortable: row.sortMode === 'provider',
        accountSortScope: null,
      };
      blocks.push(current);
      continue;
    }
    current.rows.push(row);
    if (row.sortMode === 'account' && !current.accountSortScope) current.accountSortScope = row.sortScope || null;
  }
  return blocks;
}

function _renderIntegrationBlock(block, groupId) {
  const providerSortable = block.isProviderSortable;
  const accountScope = block.accountSortScope || '';
  const classes = ['integ-section-body'];
  if (providerSortable) classes.push('integ-sort-provider-block');
  return `<tbody class="${classes.join(' ')}" data-group="${esc(groupId)}" data-sort-key="${esc(block.sortKey || '')}"${accountScope ? ` data-account-sort-scope="${esc(accountScope)}"` : ''}>
    ${block.rows.map((r) => _renderDashboardRow(r, groupId)).join('')}
  </tbody>`;
}

function _renderGroupTable(group) {
  const rows = group.rows || [];
  const blocks = _integrationRowBlocks(rows, group.id);
  return `<section class="integ-group" data-integration-group="${esc(group.id)}">
    <h2 class="acct-group-header">${esc(group.label)}</h2>
    <div class="integ-table-wrap">
      <table class="integ-table integ-dashboard-table rd-data-table">
        <thead><tr>
          <th class="integ-th-name">Provider</th>
          <th class="integ-th-type">Type</th>
          ${DATA_COLS.map((c) => `<th class="integ-th-count" title="${esc(c.title)}"><span class="material-symbols-outlined integ-col-icon">${esc(c.icon)}</span><span class="integ-col-label">${esc(c.label)}</span></th>`).join('')}
          <th class="integ-th-status">Health</th>
        </tr></thead>
        ${rows.length ? blocks.map((block) => _renderIntegrationBlock(block, group.id)).join('') : `<tbody><tr><td colspan="${DATA_COLS.length + 3}" class="integ-muted">No rows yet</td></tr></tbody>`}
      </table>
    </div>
  </section>`;
}

function _renderGroupedIntegrations(data) {
  const groups = [];
  groups.push({ id: 'robot_dojo', label: 'Robot Dojo', showAccount: false, rows: _robotDojoRows(data) });
  for (const section of (data.sections || [])) {
    const orderedSection = _orderedIntegrationSection(section);
    if (section.id === 'foundation_models') groups.push({ id: section.id, label: 'Foundation Models', showAccount: false, rows: _sectionRows(orderedSection) });
    else if (section.id === 'workspace') groups.push({ id: section.id, label: 'Workspace', showAccount: true, rows: _sectionRows(orderedSection) });
    else if (section.id === 'productivity') groups.push({ id: 'productivity', label: 'Productivity', showAccount: true, rows: _sectionRows(orderedSection) });
    else if (section.id === 'health') groups.push({ id: 'health', label: 'Health', showAccount: true, rows: _sectionRows(orderedSection) });
    else if (section.id === 'finances') groups.push({ id: 'finances', label: 'Finances', showAccount: true, rows: _sectionRows(orderedSection) });
  }
  return groups.map(_renderGroupTable).join('');
}

// st_d9fc573b AC 16 — Four Google account connect cards (personal / branded
// / family / work). Each carries data-google-account and >=40 chars of
// explicit data-instructions text directing the user to the exact screen.
function _renderGoogleConnectCards() {
  const GOOGLE_ACCOUNTS = [
    { id: 'personal', label: 'Personal Google', instructions: 'Click "Connect" then sign in with your personal Gmail address and tap "Allow" on the Google consent screen.' },
    { id: 'branded',  label: 'Branded Google',  instructions: 'Click "Connect" then sign in with your professional or branded Gmail address and tap "Allow" on the Google consent screen.' },
    { id: 'family',   label: 'Family Google',   instructions: 'Click "Connect" then sign in with the family Google account you use for shared calendars and tap "Allow" on the Google consent screen.' },
    { id: 'work',     label: 'Work Google',     instructions: 'Click "Connect" then sign in with your work Google Workspace address and tap "Allow" on the Google consent screen.' },
  ];
  return `<div class="google-connect-cards" data-section="google-accounts">${GOOGLE_ACCOUNTS.map(a => `
    <div class="acct-card google-connect-card" data-google-account="${esc(a.id)}" data-instructions="${esc(a.instructions)}">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">mail</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">${esc(a.label)}</div>
          <div class="acct-card-service">${esc(a.instructions)}</div>
        </div>
        <a class="acct-action-btn" href="/api/auth/google/start?account=${esc(a.id)}" target="_blank" rel="noopener noreferrer">Connect</a>
      </div>
    </div>`).join('')}</div>`;
}

function _isMemoryPromptCollapsed() {
  try { return localStorage.getItem(MEMORY_PROMPT_COLLAPSED_STORAGE_KEY) === '1'; }
  catch { return false; }
}

function _setMemoryPromptCollapsed(collapsed) {
  try {
    if (collapsed) localStorage.setItem(MEMORY_PROMPT_COLLAPSED_STORAGE_KEY, '1');
    else localStorage.removeItem(MEMORY_PROMPT_COLLAPSED_STORAGE_KEY);
  } catch { /* non-fatal */ }
}

function _updateMemoryPromptPanel(text, errorMessage = '') {
  const promptEl = document.getElementById('memoryPromptText');
  if (promptEl) {
    promptEl.textContent = errorMessage || text || 'Loading prompt...';
    promptEl.classList.toggle('is-error', !!errorMessage);
  }
}

async function _fetchMemoryPrompt() {
  const headers = {};
  if (_memoryPromptHash) headers['If-None-Match'] = `"${_memoryPromptHash}"`;
  const res = await fetch('/api/accounts/memory-prompt', { headers, credentials: 'same-origin' });
  if (res.status === 304) return _memoryPromptText;
  if (!res.ok) throw new Error('memory_prompt_fetch_failed');
  const data = await res.json();
  const text = (data && data.prompt) || '';
  if (!text) throw new Error('memory_prompt_empty');
  _memoryPromptText = text;
  _memoryPromptHash = data.hash || '';
  _writeMemoryPromptCache(text, _memoryPromptHash);
  _updateMemoryPromptPanel(text);
  return text;
}

async function ensureMemoryPromptText() {
  if (_memoryPromptLoadPromise) return _memoryPromptLoadPromise.then(() => _memoryPromptText);
  if (_memoryPromptText) {
    _memoryPromptLoadPromise = _fetchMemoryPrompt()
      .catch(() => _memoryPromptText)
      .finally(() => { _memoryPromptLoadPromise = null; });
    return _memoryPromptText;
  }
  _memoryPromptLoadPromise = _fetchMemoryPrompt().finally(() => { _memoryPromptLoadPromise = null; });
  return _memoryPromptLoadPromise;
}

function hydrateMemoryPromptPanel() {
  if (_isMemoryPromptCollapsed()) return;
  _updateMemoryPromptPanel(_memoryPromptText);
  ensureMemoryPromptText().catch(() => { /* visible in the prompt panel */ });
}

function toggleMemoryPromptPanel() {
  _setMemoryPromptCollapsed(!_isMemoryPromptCollapsed());
  if (activeSection === 'you') renderYou();
}

function _profileSeedChatHref() {
  return `/chat/?profile_import=1&context=${encodeURIComponent(PROFILE_SEED_CHAT_CONTEXT)}`;
}

// st_d9fc573b AC 13 — Click-to-copy of the foundation-model memory prompt.
async function copyMemoryPrompt(btn) {
  const orig = btn?.innerHTML;
  try {
    const text = await ensureMemoryPromptText();
    if (!text) { showToast('Memory prompt is empty'); return; }
    await navigator.clipboard.writeText(text);
    showToast('Memory prompt copied');
    if (btn) {
      const iconOnly = btn.classList?.contains('memory-prompt-copy');
      btn.innerHTML = iconOnly
        ? '<span class="material-symbols-outlined icon-sm">check</span>'
        : '<span class="material-symbols-outlined icon-sm">check</span><span>Copied</span>';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch (err) {
    showToast('Could not load memory prompt');
  }
}

window.copyMemoryPrompt = copyMemoryPrompt;
window.toggleMemoryPromptPanel = toggleMemoryPromptPanel;

// st_fcdbe84f AC9 — first-run profile builder. The You page keeps the
// foundation-model prompt visible; the returned answer enters through a
// profile-import chat instead of an inline paste box.
function _renderMemoryPromptPanel() {
  const collapsed = _isMemoryPromptCollapsed();
  const promptText = _memoryPromptText || 'Loading prompt...';
  return `
    <section class="memory-prompt-panel acct-card identity-showcase-card${collapsed ? ' is-collapsed' : ''}" data-card="profile-memory-prompt" aria-label="Profile memory prompt">
      <div class="memory-prompt-head">
        <div class="memory-prompt-icon"><span class="material-symbols-outlined">add_notes</span></div>
        <div class="memory-prompt-titleblock">
          <div class="memory-prompt-title">Import the model other AIs already have of you</div>
        </div>
        <div class="memory-prompt-actions">
          <button type="button" class="memory-prompt-toggle" onclick="toggleMemoryPromptPanel()" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand' : 'Minimize'}">
            <span class="material-symbols-outlined">${collapsed ? 'expand_more' : 'expand_less'}</span>
          </button>
        </div>
      </div>
      ${collapsed ? '' : `
        <div class="memory-prompt-body">
          <div class="memory-prompt-explainer">
            <p>Copy the prompt below into any AI you use (web chat or a coding agent) and bring the full response back.</p>
            <p>Miyagi ingests it, then confirms with you.</p>
          </div>
          <div class="memory-prompt-prompt-wrap">
            <div class="memory-prompt-label">Prompt for the other AI</div>
            <div class="memory-prompt-text-shell">
              <button type="button" class="memory-prompt-copy" data-memory-copy onclick="copyMemoryPrompt(this)" title="Copy prompt" aria-label="Copy prompt">
                <span class="material-symbols-outlined icon-sm">content_copy</span>
              </button>
              <pre id="memoryPromptText" class="memory-prompt-text" aria-live="polite">${esc(promptText)}</pre>
            </div>
          </div>
          <div class="memory-prompt-footer memory-prompt-footer-centered">
            <a class="memory-profile-chat-btn" href="${esc(_profileSeedChatHref())}">
              <span class="material-symbols-outlined icon-sm">add</span>
              <span>Bring the answer back</span>
            </a>
          </div>
        </div>`}
    </section>`;
}

// st_5a63545d AC 15 — Dojo-token copy. Fetches the live ROBOTDOJO_AUTH_TOKEN
// from /api/accounts/dojo-token (session-gated server-side) and copies it
// to clipboard. Also reveals the value in the masked code element so the
// user can verify before pasting elsewhere.
async function copyDojoToken(btn) {
  try {
    const res = await fetch('/api/accounts/dojo-token');
    if (!res.ok) {
      showToast(res.status === 503 ? 'Token not configured' : 'Could not load token');
      return;
    }
    const data = await res.json();
    const token = data?.token;
    if (!token) { showToast('Token is empty'); return; }
    await navigator.clipboard.writeText(token);
    showToast('Dojo token copied');
    const codeEl = btn?.closest('[data-card="dojo-token"]')?.querySelector('[data-dojo-token]')
      || document.querySelector('[data-dojo-token]');
    if (codeEl) {
      codeEl.textContent = token;
      codeEl.setAttribute('data-dojo-token', 'revealed');
    }
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Copied';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch (err) {
    showToast('Copy failed');
  }
}
// Expose for inline onclick handler.
window.copyDojoToken = copyDojoToken;

// AC6 (st_4e7e3aaf) — show/hide toggle. After reveal, the button flips to
// "Hide token" (visibility_off / hideDojoToken). hideDojoToken re-masks
// the value and flips the button back. Multiple toggle cycles supported.
async function showDojoToken(btn) {
  try {
    const res = await fetch('/api/accounts/dojo-token');
    if (!res.ok) {
      showToast(res.status === 503 ? 'Token not configured' : 'Could not load token');
      return;
    }
    const data = await res.json();
    const token = data?.token;
    const codeEl = btn?.closest('[data-card="dojo-token"]')?.querySelector('[data-dojo-token]')
      || document.querySelector('[data-dojo-token]');
    if (codeEl && token) {
      codeEl.textContent = token;
      codeEl.setAttribute('data-dojo-token', 'revealed');
    }
    if (btn) {
      btn.title = 'Hide token';
      btn.setAttribute('onclick', 'hideDojoToken(this)');
      const icon = btn.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = 'visibility_off';
    }
  } catch {
    showToast('Could not load token');
  }
}
window.showDojoToken = showDojoToken;

function hideDojoToken(btn) {
  const codeEl = btn?.closest('[data-card="dojo-token"]')?.querySelector('[data-dojo-token]')
    || document.querySelector('[data-dojo-token]');
  if (codeEl) {
    codeEl.textContent = '•••••••••••••••';
    codeEl.setAttribute('data-dojo-token', 'masked');
  }
  if (btn) {
    btn.title = 'Show token';
    btn.setAttribute('onclick', 'showDojoToken(this)');
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = 'visibility';
  }
}
window.hideDojoToken = hideDojoToken;

async function startDojoTokenEdit() {
  const editor = document.getElementById('dojoTokenEditor');
  const input = document.getElementById('dojoTokenInput');
  if (!editor || !input) return;
  editor.style.display = 'flex';
  try {
    const res = await fetch('/api/accounts/dojo-token');
    if (res.ok) {
      const data = await res.json();
      input.value = data?.token || '';
    }
  } catch { /* optional prefill */ }
  input.focus();
  input.select();
}
window.startDojoTokenEdit = startDojoTokenEdit;

function cancelDojoTokenEdit() {
  const editor = document.getElementById('dojoTokenEditor');
  const input = document.getElementById('dojoTokenInput');
  if (editor) editor.style.display = 'none';
  if (input) input.value = '';
}
window.cancelDojoTokenEdit = cancelDojoTokenEdit;

async function saveDojoToken() {
  const input = document.getElementById('dojoTokenInput');
  const token = input?.value?.trim() || '';
  if (!token) { showToast('Paste a token first'); return; }
  const res = await fetchJSON('/api/accounts/dojo-token', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res?.ok) {
    showToast(res?.error || 'Could not save token');
    return;
  }
  const codeEl = document.querySelector('[data-dojo-token]');
  if (codeEl) {
    codeEl.textContent = token;
    codeEl.setAttribute('data-dojo-token', 'revealed');
  }
  cancelDojoTokenEdit();
  showToast('Login token saved');
}
window.saveDojoToken = saveDojoToken;

async function rotateDojoToken(btn) {
  if (!confirm('Rotate the login token? This signs out every device, including this one after the response. Copy the new token now or use the local recovery command from ACCOUNT_RECOVERY.txt.')) return;
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined icon-sm">hourglass_top</span> Rotating'; }
  try {
    const res = await fetchJSON('/api/accounts/dojo-token/rotate', { method: 'POST' });
    if (!res?.ok || !res?.token) {
      showToast(res?.error || 'Could not rotate token');
      return;
    }
    const codeEl = btn?.closest('[data-card="dojo-token"]')?.querySelector('[data-dojo-token]')
      || document.querySelector('[data-dojo-token]');
    if (codeEl) {
      codeEl.textContent = res.token;
      codeEl.setAttribute('data-dojo-token', 'revealed');
    }
    await navigator.clipboard.writeText(res.token).catch(() => {});
    showToast('Login token rotated. Sign in again with the new token.');
    setTimeout(() => { window.location.href = '/login'; }, 8000);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = old; }
  }
}
window.rotateDojoToken = rotateDojoToken;

// Foundation model key actions

function openProviderKeyModal(provider) {
  // The label comes from the CARD when the provider is a card, and from the
  // ACCOUNT ROW when it is a second account inside one. A card-only lookup falls
  // through to the raw provider key, and the owner then reads an internal
  // identifier as a modal title — which is what he saw for his second Asana
  // account, in the browser, at st_dd0e19d8 QA. Two levels, not one.
  const cards = _integrationCards?.sections?.flatMap(section => section.cards || []) || [];
  const card = cards.find(c => c.provider === provider);
  const account = card ? null : cards.flatMap(c => (c.accounts || []).map(a => ({ card: c, a })))
    .find(({ a }) => a.provider === provider);
  const providerLabel = card?.name
    || (account ? `${account.card.name || account.card.provider} ${account.a.label}`.trim() : '')
    || provider;
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay key-modal-overlay';
  overlay.innerHTML = `
    <div class="confirm-modal key-modal">
      <h3>${esc(providerLabel)} API key</h3>
      <p>Stored in macOS Keychain. Paste a new key to add or replace it.</p>
      <input id="keyModalInput" type="password" class="prompt-input" placeholder="Paste API key" autocomplete="off">
      <div class="key-modal-actions">
        <button type="button" class="cancel-btn" data-action="cancel">Cancel</button>
        <button type="button" class="danger-btn" data-action="delete">Delete</button>
        <button type="button" class="confirm-btn" data-action="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#keyModalInput');
  setTimeout(() => input?.focus(), 50);
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove();
  overlay.querySelector('[data-action="delete"]').onclick = async () => {
    if (!confirm(`Delete ${provider} API key?`)) return;
    const res = await fetchJSON(`/api/accounts/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' });
    if (res?.ok) {
      overlay.remove();
      showToast(`${provider} key removed`);
      delete _keyTestResults[provider];
      await _refreshIntegrationCards();
    } else {
      showToast(res?.error || 'Failed to remove key');
    }
  };
  overlay.querySelector('[data-action="save"]').onclick = async () => {
    const key = input?.value?.trim();
    if (!key) { showToast('Paste a key first'); return; }
    const res = await fetchJSON('/api/accounts/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    if (res?.ok) {
      overlay.remove();
      showToast(`${provider} key saved`);
      delete _keyTestResults[provider];
      await _refreshIntegrationCards();
    } else {
      showToast(res?.error || 'Failed to save key');
    }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
window.openProviderKeyModal = openProviderKeyModal;

async function saveProviderKey(provider) {
  const input = $(`#keyInput_${provider}`);
  const key = input?.value?.trim();
  if (!key) { showToast('Paste a key first'); return; }
  const res = await fetchJSON('/api/accounts/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (res?.ok) {
    showToast(`${provider} key saved`);
    delete _keyTestResults[provider];
    await _refreshIntegrationCards();
  } else {
    showToast(res?.error || 'Failed to save key');
  }
}

async function testProviderKey(provider) {
  showToast(`Testing ${provider}…`);
  const res = await fetchJSON('/api/accounts/keys/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  _keyTestResults[provider] = res?.status || 'provider_error';
  showToast(`${provider}: ${INTEGRATION_STATE_LABELS[_keyTestResults[provider]] || _keyTestResults[provider]}`);
  await _refreshIntegrationCards();
}

async function removeProviderKey(provider) {
  const res = await fetchJSON(`/api/accounts/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' });
  if (res?.ok) {
    showToast(`${provider} key removed`);
    delete _keyTestResults[provider];
    await _refreshIntegrationCards();
  } else {
    showToast('Failed to remove key');
  }
}

// Notion key helpers (Notion doesn't use KEY_MAP in the foundation route)
// Notion key management now routed through saveProviderKey/removeProviderKey
// (notion added to KEY_MAP in routes/accounts.js)
async function saveNotionKey() { return saveProviderKey('notion'); }
async function removeNotionKey() { return removeProviderKey('notion'); }

async function _refreshIntegrationCards() {
  invalidateIntegrationsState();
  const fresh = await _silentFetchJSON('/api/accounts/integration-cards?refresh=1');
  if (fresh) {
    _integrationCards = fresh;
    _writeSectionCache('integrations', fresh);
    tabDataLoaded.integrations = true;
    updateSidebarCounts();
    renderIntegrations();
  }
}

// ===== Imports =====
const SOURCE_TYPE_LABELS = { imessage: 'iMessage', drive: 'Google Drive', meeting: 'Meeting Transcripts', 'health-document': 'Health Documents', document: 'Documents', task: 'Tasks', 'oura-daily': 'Oura Daily', data: 'Data Files', 'health-data': 'Health Data' };
const SOURCE_TYPE_ICONS = { imessage: 'chat', drive: 'folder', meeting: 'event_note', 'health-document': 'monitor_heart', document: 'description', task: 'task_alt', 'oura-daily': 'monitor_heart', data: 'data_object', 'health-data': 'monitor_heart' };

async function renderImports() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Imports</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = '<div class="acct-loading">Loading import history...</div>';
  const data = await loadAccountTabState('imports', () => fetchJSON('/api/accounts/imports').catch(() => null));
  if (!data) {
    feed.innerHTML = `<div class="accounts-empty">
      <span class="material-symbols-outlined accounts-empty-icon">download</span>
      <p>Couldn\u2019t load import history</p>
      <p class="accounts-empty-hint"><button type="button" onclick="renderImports()" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font:inherit">Retry</button></p>
    </div>`;
    return;
  }

  const handleMap = {};
  for (const r of (data.accountRows || [])) {
    const handle = r.email || r.display_name || r.account_id;
    if (!handleMap[handle]) handleMap[handle] = { handle, name: r.display_name, email: r.email, vendor: r.vendor, email_count: 0, cal_count: 0, llm_count: 0, earliest: null, latest: null };
    const h = handleMap[handle];
    h.email_count += r.email_count || 0; h.cal_count += r.cal_count || 0;
    for (const d of [r.email_earliest, r.email_latest, r.cal_earliest, r.cal_latest].filter(Boolean)) {
      if (!h.earliest || d < h.earliest) h.earliest = d;
      if (!h.latest || d > h.latest) h.latest = d;
    }
  }
  for (const r of (data.llmRows || [])) {
    const handle = r.email || r.name;
    if (!handleMap[handle]) handleMap[handle] = { handle, name: r.name, email: r.email, vendor: r.vendor, email_count: 0, cal_count: 0, llm_count: 0, earliest: null, latest: null };
    const h = handleMap[handle];
    h.llm_count += r.count;
    if (!h.name || h.name === handle) h.name = r.name;
    if (r.earliest && (!h.earliest || r.earliest < h.earliest)) h.earliest = r.earliest;
    if (r.latest && (!h.latest || r.latest > h.latest)) h.latest = r.latest;
  }

  const allHandles = Object.values(handleMap).sort((a, b) => {
    if (!a.latest && !b.latest) return 0; if (!a.latest) return 1; if (!b.latest) return -1;
    return a.latest > b.latest ? -1 : 1;
  });

  const compact = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
  const iconCell = (icon, title, count) => `<div class="import-icon-cell"><span class="material-symbols-outlined icon-sm" title="${title}">${icon}</span><span class="import-icon-count">${compact(count)}</span></div>`;
  const activeEmails = new Set(allAccounts.map(a => a.email).filter(Boolean));

  let hasImportRows = false;
  let html = '<div class="acct-card"><div class="acct-section-title">Import drop zone</div><p class="accounts-empty-hint">Drop files into <code>~/robotdojo/user/inbox</code>. Robot Dojo records status, retry, error, and recovery history in <code>~/robotdojo/user/imports</code> until each file is processed, skipped, or needs your attention.</p></div>';
  if (allHandles.length) {
    hasImportRows = true;
    html += '<div class="acct-card"><div class="acct-section-title">Imported Data by Account</div>';
    html += '<table class="imports-data-table acct-fixed-cols rd-data-table"><thead><tr><th class="col-account">Account</th><th class="col-data-icons">LLM</th><th class="col-data-icons">Email</th><th class="col-data-icons">Cal</th><th class="col-date">From</th><th class="col-date">To</th><th class="col-status">Status</th></tr></thead><tbody>';
    for (const h of allHandles) {
      const primary = h.email || h.name || h.handle;
      const secondary = h.email && h.name && h.name !== primary ? h.name : '';
      const isActive = activeEmails.has(h.email) || activeEmails.has(h.handle) || (h.llm_count > 0 && !h.email_count && !h.cal_count);
      html += `<tr>
        <td data-label="Account">${esc(primary)}${secondary ? `<div style="font-size:11px;color:var(--muted)">${esc(secondary)}</div>` : ''}</td>
        <td data-label="LLM" class="col-data-icons">${h.llm_count > 0 ? iconCell('smart_toy', 'LLM Chats', h.llm_count) : ''}</td>
        <td data-label="Email" class="col-data-icons">${h.email_count > 0 ? iconCell('mail', 'Emails', h.email_count) : ''}</td>
        <td data-label="Cal" class="col-data-icons">${h.cal_count > 0 ? iconCell('calendar_month', 'Calendar Events', h.cal_count) : ''}</td>
        <td data-label="From" class="col-date">${h.earliest ? _formatFrDate(h.earliest) : ''}</td>
        <td data-label="To" class="col-date">${isActive ? 'Present' : (h.latest ? _formatFrDate(h.latest) : '')}</td>
        <td data-label="Status" class="col-status"><span class="material-symbols-outlined import-check">check_circle</span></td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }

  const excludeFromOther = new Set(['calendar', 'drive', 'email', 'email-summary', 'conversation']);
  const otherSources = (data.ragSources || []).filter(s => !excludeFromOther.has(s.source_type));
  if (otherSources.length) {
    hasImportRows = true;
    html += '<div class="acct-card"><div class="acct-section-title">Other Data Sources</div>';
    html += '<table class="imports-data-table acct-fixed-cols rd-data-table"><thead><tr><th class="col-account">Source</th><th class="col-data-icons">Data</th><th class="col-data-icons"></th><th class="col-data-icons"></th><th class="col-date">From</th><th class="col-date">To</th><th class="col-status">Status</th></tr></thead><tbody>';
    for (const s of otherSources) {
      const label = SOURCE_TYPE_LABELS[s.source_type] || s.source_type;
      const icon = SOURCE_TYPE_ICONS[s.source_type] || 'data_object';
      html += `<tr><td data-label="Source">${esc(label)}</td><td data-label="Data" class="col-data-icons">${iconCell(icon, label, s.item_count)}</td><td></td><td></td>
        <td data-label="From" class="col-date">${s.earliest ? _formatFrDate(s.earliest) : ''}</td><td data-label="To" class="col-date">${s.latest ? 'Present' : ''}</td>
        <td data-label="Status" class="col-status"><span class="material-symbols-outlined import-check">check_circle</span></td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  const dropRows = data.dropFolderRows || [];
  if (dropRows.length) {
    hasImportRows = true;
    html += '<div class="acct-card"><div class="acct-section-title">Files in import history</div>';
    html += '<table class="imports-data-table acct-fixed-cols rd-data-table"><thead><tr><th class="col-account">File</th><th class="col-data-icons">Type</th><th class="col-data-icons">Topic</th><th class="col-data-icons"></th><th class="col-date">Updated</th><th class="col-date"></th><th class="col-status">Status</th></tr></thead><tbody>';
    for (const f of dropRows) {
      const topic = [f.topic_t1, f.topic_t2].filter(Boolean).join(' / ');
      const status = f.status || 'unknown';
      const statusClass = status === 'processed' ? 'imported' : status === 'needs_user' ? 'error' : status === 'duplicate' ? 'skipped' : 'pending';
      html += `<tr>
        <td data-label="File">${esc(f.original_name || 'Imported file')}${f.error_message ? `<div style="font-size:11px;color:var(--muted)">${esc(f.error_message)}</div>` : ''}</td>
        <td data-label="Type" class="col-data-icons">${esc(f.doc_type || 'file')}</td>
        <td data-label="Topic" class="col-data-icons">${esc(topic || 'Unsorted')}</td>
        <td></td>
        <td data-label="Updated" class="col-date">${f.processed_at ? _formatFrDate(f.processed_at) : ''}</td>
        <td></td>
        <td data-label="Status" class="col-status"><span class="import-status-badge import-status-${statusClass}">${esc(status.replace(/_/g, ' '))}</span></td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }

  feed.innerHTML = hasImportRows ? html : html + `<div class="accounts-empty">
    <span class="material-symbols-outlined accounts-empty-icon">download</span>
    <p>No imports yet</p>
    <p class="accounts-empty-hint">Drop files into <code>~/robotdojo/user/inbox</code>, or connect an account in <a href="/account/integrations" onclick="setSection('integrations');return false;">Integrations</a>.</p>
  </div>`;
}

// st_d9fc573b — Invite a Friend tab.
// st_b879a361 — Professional leg is now paginated (10×3 cap=30), filtered
// by the YC + big-tech + VC + AI-content qualification, and sorted 4-tier
// (Path C qualifiers first, then by company tier, then by role bucket, then
// by recency). The Personal leg keeps the legacy 3-row contract.
//
// "Show More" appends the next 10 contacts until has_more=false or the
// 30-cap is reached.
// st_4e7e3aaf AC14 — Refer a Friend is a single click-to-copy paragraph.
// The legacy contact-list fetch is gone; no mailto flow. If the paragraph
// text changes it requires a code edit — acceptable tradeoff for a
// launch-time surface.
const REFERRAL_PARAGRAPH = 'Robot Dojo is a personal AI that actually remembers you. It runs on your Mac, keeps your data local, and gets smarter over time as it learns from your emails, calendar, messages, and files. Private beta: https://robotdojo.ai';

async function renderReferrals() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Refer a Friend</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = `
    <div class="acct-card referral-share-card" data-card="referral-share">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">person_add</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">Share Robot Dojo</div>
          <div class="acct-card-service">One paragraph you can paste anywhere — text, email, DM.</div>
        </div>
        <button type="button" class="acct-action-btn" onclick="copyReferralText(this)" title="Copy paragraph">
          <span class="material-symbols-outlined icon-sm">content_copy</span> Copy
        </button>
      </div>
      <p class="referral-paragraph">${esc(REFERRAL_PARAGRAPH)}</p>
    </div>`;
}

async function copyReferralText(btn) {
  try {
    await navigator.clipboard.writeText(REFERRAL_PARAGRAPH);
    showToast('Copied');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined icon-sm">check</span> Copied';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch {
    showToast('Copy failed');
  }
}
window.copyReferralText = copyReferralText;

// ===== Add Account Form =====

// Category-based vendor picker. Groups surface intent clearly over the flat
// type→vendor dropdowns, which required two steps and buried common choices.
// WHY: ADD_CATEGORIES now separates static (OAuth + special) entries from
// catalog-driven api_key entries. The static list covers non-api_key providers
// (OAuth, granola, imessage). Catalog api_key providers are injected dynamically
// by buildAddCategories() when integration-cards data is available.
const ADD_CATEGORIES_STATIC = [
  // Microsoft is NOT in this email/calendar picker on purpose: its card is visible
  // on the accounts page (st_fd14cdd4 unhid it) but it connects via the tenant-admin
  // Graph app-credentials flow on its own card ("Set up app credentials"), not this
  // OAuth-style email/calendar tuple picker. Keeping it out of this list avoids a
  // dead picker entry that would route to the wrong (delegated) flow.
  { label: 'Email & Calendar',   items: [['google','email'],['google','calendar']] },
  { label: 'Cloud Storage',      items: [['google','drive']] },
  { label: 'Other',              items: [['granola','other'],['imessage','sms']] },
];

// Friendly display names for vendor+type combos shown in the category grid
const ADD_ITEM_LABELS = {
  'openai:other':       'OpenAI',
  'xai:other':          'xAI',
  'ollama:other':       'Ollama',
  'google:email':       'Gmail',
  'google:calendar':    'Google Calendar',
  'microsoft:email':    'Outlook Mail',
  'microsoft:calendar': 'Outlook Calendar',
  'google:drive':       'Google Drive',
  'notion:other':       'Notion',
  'asana:task':         'Asana',
  'oura:other':         'Oura Ring',
  'granola:other':      'Granola',
  'imessage:sms':       'iMessage',
};

// WHY: extract catalog api_key providers from integration-cards data so the
// Add form always reflects the DB catalog without a code change or deploy.
function getApiKeyCatalogItems() {
  if (!_integrationCards) return [];
  const catalogProviders = new Set();
  const items = [];
  for (const section of _integrationCards.sections || []) {
    for (const card of section.cards || []) {
      if (card.provider === 'mistral') continue;
      if (card.auth === 'api_key' && !catalogProviders.has(card.provider)) {
        catalogProviders.add(card.provider);
        items.push([card.provider, 'other', card.name]);
      }
    }
  }
  return items;
}

// Build ADD_CATEGORIES dynamically by merging static entries with catalog api_key providers.
function buildAddCategories() {
  const catalogItems = getApiKeyCatalogItems();
  const aiItems = catalogItems.filter(([p]) => ['anthropic','openai','xai','google'].includes(p)).map(([p,,n]) => [p, 'other', n]);
  // Add Ollama (host-based, not in catalog)
  aiItems.push(['ollama', 'other', 'Ollama']);

  const productivityItems = catalogItems.filter(([p]) => !['anthropic','openai','xai','google'].includes(p)).map(([p,,n]) => [p, 'other', n]);

  const cats = [];
  if (aiItems.length) cats.push({ label: 'AI Models', items: aiItems, fromCatalog: true });
  cats.push(...ADD_CATEGORIES_STATIC);
  if (productivityItems.length) cats.push({ label: 'API Keys', items: productivityItems, fromCatalog: true });
  return cats;
}

function showAddForm() {
  if (activeSection !== 'integrations') setSection('integrations');
  if ($('.acct-add-form')) return;
  const feed = $('#accountsFeed');
  const form = document.createElement('div');
  form.className = 'acct-add-form';

  // WHY: buildAddCategories() merges static OAuth/special entries with catalog
  // api_key providers so the form always reflects the DB catalog.
  const addCategories = buildAddCategories();
  let categoriesHtml = '';
  for (const cat of addCategories) {
    const btns = cat.items.map(([vendor, type, catalogName]) => {
      // catalogName is set for catalog-driven items; fall back to ADD_ITEM_LABELS then vendor
      const label = catalogName || ADD_ITEM_LABELS[`${vendor}:${type}`] || vendor;
      return `<button type="button" class="acct-category-btn" onclick="addAccount('${esc(vendor)}','${esc(type)}')">${esc(label)}</button>`;
    }).join('');
    categoriesHtml += `<div class="acct-category-group"><div class="acct-category-label">${esc(cat.label)}</div><div class="acct-category-btns">${btns}</div></div>`;
  }

  form.innerHTML = `<h3>Add Account</h3>
    <div id="acctCategoryPicker">${categoriesHtml}</div>
    <div id="addFields"></div>
    <div class="acct-form-actions">
      <button class="acct-form-cancel" onclick="hideAddForm()">Cancel</button>
      <button class="acct-form-submit" id="addSubmitBtn" onclick="submitAddForm()" style="display:none">Add</button>
    </div>`;

  // Hidden selects used by existing submitAddForm() logic — not visible to the user
  const hiddenType   = document.createElement('select'); hiddenType.id = 'addType';   hiddenType.style.display = 'none';
  const hiddenVendor = document.createElement('select'); hiddenVendor.id = 'addVendor'; hiddenVendor.style.display = 'none';
  form.appendChild(hiddenType);
  form.appendChild(hiddenVendor);

  feed.insertBefore(form, feed.firstChild);
}

function openIntegrationAddAccount(provider) {
  const key = String(provider || '').toLowerCase();
  if (key === 'apple') {
    // st_4e7e3aaf AC11 — Apple FDA via direct settings button, no terminal.
    showAppleFdaModal();
    return;
  }
  if (key === 'google') {
    window.location.href = _oauthConnectHref(key);
    return;
  }
  if (key === 'microsoft') {
    showAddForm();
    addAccount('microsoft', 'email');
    return;
  }
  if (key === 'granola') {
    // st_4e7e3aaf AC11 — Sign in opens the local Granola Mac app via
    // /api/accounts/open-app — no /auth/granola click-through.
    showGranolaSignInModal();
    return;
  }
  if (key === 'asana' || key === 'asana_secondary' || key === 'notion' || key === 'oura') {
    openProviderKeyModal(key);
    return;
  }
  showAddForm();
}
window.openIntegrationAddAccount = openIntegrationAddAccount;

// Called when a category button is clicked. Pre-selects vendor+type then
// renders the credential fields inline — same logic as updateFormFields(),
// but skips the now-hidden dropdowns.
function addAccount(vendor, type) {
  // Populate hidden selects so submitAddForm() finds the right values
  const typeEl = $('#addType');
  const vendorEl = $('#addVendor');
  if (!typeEl || !vendorEl) return;

  // Build option lists from allVendors (same data source as before)
  typeEl.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${esc(k)}"${k === type ? ' selected' : ''}>${esc(v)}</option>`).join('');

  let vendorOpts = '';
  for (const [key, v] of Object.entries(allVendors)) {
    if (v.types.includes(type)) {
      const fieldsAttr = v.fields?.length ? ` data-fields="${esc(v.fields.join(','))}"` : '';
      vendorOpts += `<option value="${esc(key)}" data-auth="${esc(v.auth)}"${fieldsAttr}${key === vendor ? ' selected' : ''}>${esc(v.name)}</option>`;
    }
  }
  vendorEl.innerHTML = vendorOpts || `<option value="${esc(vendor)}" data-auth="api_key">${esc(vendor)}</option>`;

  // Show the credential fields and submit button
  const submitBtn = $('#addSubmitBtn');
  if (submitBtn) submitBtn.style.display = '';
  updateFormFields();
}

function hideAddForm() { const f = $('.acct-add-form'); if (f) f.remove(); }

function updateVendorOptions() {
  const type = $('#addType').value;
  let opts = '';
  for (const [key, v] of Object.entries(allVendors)) {
    if (v.types.includes(type)) {
      const fieldsAttr = v.fields?.length ? ` data-fields="${esc(v.fields.join(','))}"` : '';
      opts += `<option value="${esc(key)}" data-auth="${esc(v.auth)}"${fieldsAttr}>${esc(v.name)}</option>`;
    }
  }
  $('#addVendor').innerHTML = opts || '<option value="" disabled>No vendors for this type</option>';
  updateFormFields();
}

function updateFormFields() {
  const opt = $('#addVendor').selectedOptions[0];
  const fieldsDiv = $('#addFields');
  if (!opt?.value) { fieldsDiv.innerHTML = ''; return; }

  const auth = opt.dataset.auth;
  const submitBtn = $('#addSubmitBtn');
  const vendorKey = $('#addVendor').value;

  if (vendorKey === 'microsoft') {
    const tenantConfigured = !!secretsStatus.secrets?.MICROSOFT_TENANT_ID?.configured;
    const clientConfigured = !!secretsStatus.secrets?.MICROSOFT_CLIENT_ID?.configured;
    const secretConfigured = !!secretsStatus.secrets?.MICROSOFT_CLIENT_SECRET?.configured;
    fieldsDiv.innerHTML = `
      <div class="acct-form-row"><label>Display Name</label><input type="text" id="addName" placeholder="Work Microsoft"></div>
      <div class="acct-form-row"><label>Tenant ID${tenantConfigured ? ' <span style="color:var(--success);font-size:12px">(configured)</span>' : ''}</label><input type="password" id="msTenantId" placeholder="${tenantConfigured ? 'Leave blank to keep current' : 'Paste tenant ID'}" autocomplete="off"></div>
      <div class="acct-form-row"><label>Client ID${clientConfigured ? ' <span style="color:var(--success);font-size:12px">(configured)</span>' : ''}</label><input type="password" id="msClientId" placeholder="${clientConfigured ? 'Leave blank to keep current' : 'Paste client ID'}" autocomplete="off"></div>
      <div class="acct-form-row"><label>Client Secret${secretConfigured ? ' <span style="color:var(--success);font-size:12px">(configured)</span>' : ''}</label><input type="password" id="msClientSecret" placeholder="${secretConfigured ? 'Leave blank to keep current' : 'Paste client secret'}" autocomplete="off"></div>
      <div class="acct-form-row"><label>Mailbox Email</label><input type="email" id="msMailboxEmail" placeholder="person@company.com" autocomplete="email"></div>
      <p style="font-size:12px;color:var(--muted);margin:6px 0 0">Use the tenant-admin Graph app path: add Application permission <strong>Mail.ReadWrite</strong> or <strong>Mail.Read</strong>, add <strong>Calendars.Read</strong> for calendar, click <strong>Grant admin consent</strong>, then add the mailbox here. Do not use the Microsoft delegated approval prompt.</p>`;
    submitBtn.textContent = 'Save & Add Mailbox';
    return;
  }

  if (auth === 'oauth' || auth === 'app_credentials') {
    const secretKey = secretsStatus.vendorSecrets?.[vendorKey];
    const secretInfo = secretKey ? secretsStatus.secrets?.[secretKey] : null;
    const hasSecret = secretInfo?.configured;
    let secretHtml = secretInfo ? `<div class="acct-form-row"><label>${esc(secretInfo.label)}${hasSecret ? ' <span style="color:var(--success);font-size:12px">(configured)</span>' : ''}</label><input type="password" id="addSecret" placeholder="${hasSecret ? 'Leave blank to keep current' : 'Paste secret here'}" autocomplete="off"><p style="font-size:12px;color:var(--muted);margin:4px 0 0">Stored in macOS Keychain, not on disk.</p></div>` : '';
    fieldsDiv.innerHTML = `<div class="acct-form-row"><label>Display Name</label><input type="text" id="addName" placeholder="My ${esc(opt.textContent)} Account"></div>${secretHtml}
      <p style="font-size:13px;color:var(--muted);margin:8px 0 0">${hasSecret ? 'Secret configured. Update it or click Connect.' : 'Connect with the provider. Any required app secret stays in Keychain.'}</p>`;
    submitBtn.textContent = hasSecret ? 'Connect' : 'Save & Connect';
  } else {
    const fieldNames = opt.dataset.fields ? opt.dataset.fields.split(',') : ['api_key'];
    let fieldsHtml = '';
    if (fieldNames.length === 1) {
      fieldsHtml = `<div class="acct-form-row"><label>API Key / Token</label><textarea id="addApiKey" data-field="${esc(fieldNames[0])}" placeholder="Paste your API key or token here" rows="3"></textarea></div>`;
    } else {
      for (const fname of fieldNames) {
        const label = FIELD_LABELS[fname] || fname.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        fieldsHtml += `<div class="acct-form-row"><label>${esc(label)}</label><input type="password" class="addFieldInput" data-field="${esc(fname)}" placeholder="Paste ${esc(label.toLowerCase())}" autocomplete="off"></div>`;
      }
    }
    fieldsDiv.innerHTML = `<div class="acct-form-row"><label>Display Name</label><input type="text" id="addName" placeholder="My ${esc(opt.textContent)}"></div>${fieldsHtml}<p style="font-size:12px;color:var(--muted);margin:4px 0 0">Stored in macOS Keychain + database.</p>`;
    submitBtn.textContent = 'Save';
  }
}

async function submitAddForm() {
  const vendor = $('#addVendor').value;
  const type = $('#addType').value;
  const name = $('#addName')?.value || '';
  const opt = $('#addVendor').selectedOptions[0];
  const auth = opt?.dataset.auth;
  if (!vendor) { showToast('Select a vendor'); return; }

  if (vendor === 'microsoft') {
    const secrets = [
      ['MICROSOFT_TENANT_ID', $('#msTenantId')?.value?.trim() || '', !!secretsStatus.secrets?.MICROSOFT_TENANT_ID?.configured],
      ['MICROSOFT_CLIENT_ID', $('#msClientId')?.value?.trim() || '', !!secretsStatus.secrets?.MICROSOFT_CLIENT_ID?.configured],
      ['MICROSOFT_CLIENT_SECRET', $('#msClientSecret')?.value?.trim() || '', !!secretsStatus.secrets?.MICROSOFT_CLIENT_SECRET?.configured],
    ];
    for (const [key, value, configured] of secrets) {
      if (!value && !configured) {
        showToast(`${key.replace('MICROSOFT_', '').replace(/_/g, ' ')} is required`);
        return;
      }
      if (value) {
        const storeRes = await fetchJSON('/api/accounts/store-secret', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        if (!storeRes?.ok) { showToast(storeRes?.error || 'Failed to store Microsoft credential'); return; }
      }
    }
    const email = $('#msMailboxEmail')?.value?.trim() || '';
    if (!email) { showToast('Mailbox email is required'); return; }
    const res = await fetchJSON('/api/integrations/microsoft/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName: name || email }),
    });
    if (res?.ok) {
      showToast(res.message || 'Microsoft mailbox connected');
      hideAddForm();
      invalidateIntegrationsState();
      await renderIntegrations();
    } else {
      showToast(res?.message || res?.error || 'Microsoft setup failed');
    }
    return;
  }

  if (auth === 'oauth' || auth === 'app_credentials') {
    const secretInput = $('#addSecret');
    const secretKey = secretsStatus.vendorSecrets?.[vendor];
    const secretConfigured = secretKey && secretsStatus.secrets?.[secretKey]?.configured;
    if (secretInput?.value && secretKey) {
      const storeRes = await fetchJSON('/api/accounts/store-secret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: secretKey, value: secretInput.value }) });
      if (!storeRes?.ok) { showToast('Failed to store secret'); return; }
      showToast('Secret saved to Keychain');
    } else if (secretInput && !secretInput.value && !secretConfigured) { showToast('Secret is required'); return; }

    window.open(_oauthConnectHref(vendor, null, name || opt.textContent), '_blank', 'noopener,noreferrer');
    return;
  }

  // API key flow
  // WHY: catalog providers (foundation models + productivity) use /api/accounts/keys
  // which writes directly to Keychain and is catalog-backed. Legacy /api/accounts
  // is for OAuth providers and multi-field integrations not in the catalog.
  const isCatalogProvider = _integrationCards?.sections
    .flatMap(s => s.cards)
    .some(c => c.provider === vendor && c.auth === 'api_key');

  if (isCatalogProvider) {
    const apiKey = $('#addApiKey')?.value?.trim() || '';
    if (!apiKey) { showToast('API key is required'); return; }
    const res = await fetchJSON('/api/accounts/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: vendor, key: apiKey }) });
    if (res?.ok) { showToast(`${vendor} key saved`); hideAddForm(); invalidateIntegrationsState(); await renderIntegrations(); }
    else showToast(res?.error || 'Failed to save key');
    return;
  }

  if (!name) { showToast('Display name is required'); return; }
  const fieldNames = opt?.dataset.fields ? opt.dataset.fields.split(',') : ['api_key'];
  let body;
  if (fieldNames.length === 1) {
    const apiKey = $('#addApiKey')?.value || '';
    if (!apiKey) { showToast('API key is required'); return; }
    body = { type, vendor, displayName: name, apiKey };
  } else {
    const fields = {};
    for (const fname of fieldNames) {
      const val = document.querySelector(`.addFieldInput[data-field="${fname}"]`)?.value?.trim() || '';
      if (!val) { showToast(`${FIELD_LABELS[fname] || fname} is required`); return; }
      fields[fname] = val;
    }
    body = { type, vendor, displayName: name, fields };
  }
  const res = await fetchJSON('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res && !res.error) { showToast('Account added'); hideAddForm(); invalidateIntegrationsState(); await renderIntegrations(); }
  else if (res?.error) showToast(res.error);
}

// --- Account actions ---
async function editAccountKey(id, name) {
  const newKey = prompt(`New API key for "${name}":`);
  if (!newKey?.trim()) return;
  const res = await fetchJSON(`/api/accounts/${id}/key`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: newKey.trim() }) });
  if (res?.ok) { showToast('Key updated'); invalidateIntegrationsState(); await renderIntegrations(); } else showToast('Failed to update key');
}

async function editLlmKey(envKey, label) {
  const newKey = prompt(`New key for ${label}:`);
  if (!newKey?.trim()) return;
  const res = await fetchJSON('/api/accounts/store-secret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: envKey, value: newKey.trim() }) });
  if (res?.ok) { showToast(`${label} key updated`); invalidateIntegrationsState(); await renderIntegrations(); } else showToast('Failed to update key');
}

function deleteAccountPrompt(id, name) {
  showConfirmModal('Delete Account', `Delete "${name}"?`, 'Delete', async () => {
    if (await fetchJSON(`/api/accounts/${id}`, { method: 'DELETE' })) { showToast('Deleted'); invalidateIntegrationsState(); await renderIntegrations(); }
  });
}

// ============================================================================
// ===== Shared toggle helpers (used by General, Reporting, Assistant) ========
// ============================================================================

// _betaState stores feature toggle state across the page. Initialised here so
// renderGeneral() (which runs before any Releases fetch) can read it safely.
let _betaState = {};

// Reusable toggle switch HTML. id must be unique in the DOM. Used by
// renderGeneral (feature toggles), renderReporting (telemetry), and
// renderAssistant (export targets).
function _switchHtml(id, checked, onchange) {
  return `<label class="rel-switch"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''} onchange="${onchange}"><span class="rel-switch-slider"></span></label>`;
}

// ============================================================================
// ===== Preferences (Telemetry + Feature Requests) ===========================
// ============================================================================

const TELEMETRY_KEYS = [
  { key: 'usage',                  label: 'Usage telemetry',                  desc: 'High-level stats: which features you use, session counts. No content.' },
  { key: 'error_reporting',        label: 'Error reporting',                  desc: 'When something breaks, send the error + stack trace. No user data.' },
  { key: 'include_screenshots',    label: 'Include screenshots in error reports', desc: 'Visual context when the UI breaks. PII is blurred client-side before sending.' },
  { key: 'include_chat_sessions',  label: 'Include chat session in error reports', desc: 'The conversation leading up to the error. PII is redacted client-side.' },
];

let _telemetryState = { usage: false, error_reporting: false, include_screenshots: false, include_chat_sessions: false };
let _featureRequests = [];

// ===== Feature Requests =====
// Extracted from the old renderPreferences(). Telemetry content moved to renderReporting().
// st_d9fc573b — Feature Request is one textarea + one required email + one
// submit. No title field, no telemetry, no prior-requests list (AC 7). The
// submit POSTs to the production Vercel /api/feedback endpoint as a
// feature_request kind. The form element carries data-tab="feature-request"
// for the VC 7 verifier.
// st_4e7e3aaf AC13 — Feature Request is a single message box with name +
// email. Name is required so we can attribute and follow up.
async function renderFeatureRequests() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Feature Request</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = `
    <form class="acct-card feature-request-form" data-tab="feature-request" onsubmit="submitFeatureRequest(event); return false;">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">lightbulb</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">Feature Request</div>
          <div class="acct-card-service">Tell us what would make setup, chat, or integrations clearer.</div>
        </div>
      </div>
      <p class="feature-request-help">Keep it short — one or two sentences.</p>
      <div class="acct-form-row">
        <label for="frName">Name</label>
        <input id="frName" name="name" type="text" required placeholder="Your name">
      </div>
      <div class="acct-form-row">
        <label for="frBody">Message</label>
        <textarea id="frBody" name="description" rows="5" required placeholder="What should Robot Dojo do better?"></textarea>
      </div>
      <div class="acct-form-row">
        <label for="frEmail">Email</label>
        <input id="frEmail" name="email" type="email" required placeholder="you@example.com">
      </div>
      <div class="acct-form-actions">
        <button type="submit" class="acct-form-submit" id="frSubmitBtn">
          <span class="material-symbols-outlined icon-sm">send</span> Send
        </button>
      </div>
      <div id="frStatus" class="report-issue-status" style="display:none"></div>
    </form>`;
  const ta = $('#frBody');
  if (ta) {
    const end = ta.value.length;
    ta.focus();
    try { ta.setSelectionRange(end, end); } catch { /* */ }
  }
}

// ===== Reporting =====
// Extracted from the old renderPreferences(). Telemetry toggles live here now.
async function renderReporting(renderCycle = _renderCycle) {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Reporting</span>';
  const feed = $('#accountsFeed');
  feed.innerHTML = '<div class="acct-loading">Loading…</div>';

  const tel = await _silentFetchJSON('/api/account/telemetry');
  if (isStaleRender(renderCycle)) return;
  if (tel) _telemetryState = { ..._telemetryState, ...tel };

  const telemetryCard = `
    <div class="acct-card">
      <div class="acct-card-header">
        <div class="acct-card-icon"><span class="material-symbols-outlined">insights</span></div>
        <div class="acct-card-title">
          <div class="acct-card-name">Telemetry</div>
          <div class="acct-card-service">Help us improve Robot Dojo. All off by default. PII scrubbed before anything leaves your machine.</div>
        </div>
      </div>
      ${TELEMETRY_KEYS.map((t, i) => `
        <div class="rel-toggle-row">
          <div class="rel-toggle-label">
            <div class="rel-toggle-name">${esc(t.label)}</div>
            <div class="rel-toggle-desc">${esc(t.desc)}</div>
          </div>
          ${_switchHtml('tel_' + t.key, !!_telemetryState[t.key], `toggleTelemetry('${t.key}', this.checked)`)}
        </div>${i < TELEMETRY_KEYS.length - 1 ? '<div class="rel-divider"></div>' : ''}`).join('')}
    </div>`;

  feed.innerHTML = telemetryCard;
}

function _formatFrDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(+d)) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

async function toggleTelemetry(key, on) {
  _telemetryState[key] = !!on;
  const res = await fetchJSON('/api/account/telemetry', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: !!on }),
  });
  if (!res?.ok && !res) showToast('Saved locally — backend not ready');
  else showToast(`${key}: ${on ? 'on' : 'off'}`);
}

async function submitFeatureRequest(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  // st_4e7e3aaf AC13 — name + body + email. Strip neutral chat-feedback
  // prefixes if the user typed one here, then send plain feedback text.
  const name = $('#frName')?.value?.trim() || '';
  const rawBody = $('#frBody')?.value || '';
  const email = $('#frEmail')?.value?.trim() || '';
  const status = $('#frStatus');
  const body = rawBody.replace(/^(@feedback\s*)+/i, '').trim();
  if (!name) {
    if (status) { status.textContent = 'Please enter your name.'; status.style.display = ''; }
    return;
  }
  if (!body) {
    if (status) { status.textContent = 'Please describe what you would like to see.'; status.style.display = ''; }
    return;
  }
  if (!email) {
    if (status) { status.textContent = 'Please enter your email so we can follow up.'; status.style.display = ''; }
    return;
  }
  const btn = $('#frSubmitBtn');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Sending…'; status.style.display = ''; }
  try {
    const res = await fetch('https://robotdojo.ai/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'feature_request',
        name,
        description: body,
        email,
        url: location.href,
        userAgent: navigator.userAgent,
        source: 'Accounts > Feature Request',
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      if (status) status.textContent = 'Sent. Thanks — it is in the Robot Dojo task queue.';
      const ta = $('#frBody'); if (ta) ta.value = '';
      const ne = $('#frName'); if (ne) ne.value = '';
      if (btn) btn.disabled = false;
    } else {
      if (status) status.textContent = json.fallback || json.error || 'Submit failed.';
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    if (status) status.textContent = 'Network error — please try again.';
    if (btn) btn.disabled = false;
  }
}

// ============================================================================
// ===== Delete ===============================================================
// ============================================================================
// Destructive actions, each with a type-to-confirm DELETE gate. We
// render them as a stacked card list with danger accents. The "armed"
// button only enables once the input exactly matches DELETE (case-sensitive
// on purpose — matches Stripe's pattern).

const DELETE_ACTIONS = [
  {
    id: 'data',
    icon: 'delete_sweep',
    title: 'Hard-reset my data',
    desc: 'Wipe imported emails, calendar, messages, contacts, and extracted records. Keeps your local account, settings, and access state. You can re-import anytime.',
    endpoint: '/api/account/delete/data',
    buttonLabel: 'Wipe imported data',
  },
  {
    id: 'subscription',
    icon: 'cancel',
    title: 'Cancel Black Belt',
    desc: 'Turn off Black Belt engines after the grace window. White Belt keeps working. Your raw data and user-created artifacts stay on your machine.',
    endpoint: '/api/account/delete/subscription',
    buttonLabel: 'Cancel Black Belt',
  },
  {
    id: 'full',
    icon: 'person_remove',
    title: 'Delete my account',
    desc: 'Full local delete: account, sessions, imported data, and generated local state. Irreversible.',
    endpoint: '/api/account/delete/full',
    buttonLabel: 'Delete account',
    severe: true,
  },
];

function renderDelete() {
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Delete</span>';
  const feed = $('#accountsFeed');

  let html = `
    <div class="delete-intro">
      <p class="delete-intro-text">Easy to leave. Your choice, not our stickiness.</p>
    </div>`;

  for (const a of DELETE_ACTIONS) {
    html += `
      <div class="acct-card delete-card${a.severe ? ' delete-card-severe' : ''}" data-delete="${esc(a.id)}">
        <div class="acct-card-header">
          <div class="acct-card-icon delete-card-icon"><span class="material-symbols-outlined">${esc(a.icon)}</span></div>
          <div class="acct-card-title">
            <div class="acct-card-name">${esc(a.title)}</div>
            <div class="acct-card-service">${esc(a.desc)}</div>
          </div>
        </div>
        <div class="delete-confirm-row">
          <input type="text" class="delete-confirm-input" data-for="${esc(a.id)}"
                 placeholder="Type DELETE to confirm"
                 oninput="_armDelete('${esc(a.id)}', this.value)">
          <button class="delete-confirm-btn" id="delBtn_${esc(a.id)}" disabled
                  onclick="confirmDelete('${esc(a.id)}')">
            ${esc(a.buttonLabel)}
          </button>
        </div>
        <div class="delete-status" id="delStatus_${esc(a.id)}"></div>
      </div>`;
  }

  feed.innerHTML = html;
}

function _armDelete(id, value) {
  const btn = $(`#delBtn_${id}`);
  if (!btn) return;
  btn.disabled = value !== 'DELETE';
}

async function confirmDelete(id) {
  const action = DELETE_ACTIONS.find(a => a.id === id);
  if (!action) return;
  const btn = $(`#delBtn_${id}`);
  const statusEl = $(`#delStatus_${id}`);
  const input = document.querySelector(`.delete-confirm-input[data-for="${id}"]`);
  if (input?.value !== 'DELETE') return;

  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try {
    const res = await fetchJSON(action.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    if (res?.ok || (res && !res.error)) {
      if (statusEl) {
        statusEl.innerHTML = '<span class="import-status-badge import-status-imported">done</span> ' +
          (action.id === 'full' ? 'Account deleted. Signing you out…' : 'Done.');
      }
      if (action.id === 'full') {
        setTimeout(async () => {
          try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* */ }
          location.href = '/';
        }, 1500);
      } else if (action.id === 'data') {
        // Data wipe — reload so the rest of the UI stops referencing gone rows.
        setTimeout(() => location.reload(), 1500);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = action.buttonLabel; }
        if (input) input.value = '';
      }
    } else {
      if (statusEl) statusEl.innerHTML = '<span class="import-status-badge import-status-error">error</span> ' + esc(res?.error || 'Failed — backend not ready');
      if (btn) { btn.disabled = false; btn.textContent = action.buttonLabel; }
    }
  } catch {
    if (statusEl) statusEl.innerHTML = '<span class="import-status-badge import-status-error">error</span> Network error';
    if (btn) { btn.disabled = false; btn.textContent = action.buttonLabel; }
  }
}

// ============================================================================
// ===== Admin ================================================================
// ============================================================================

function renderAdmin() {
  if (!_adminStatus.is_admin) { renderGeneral(); return; }
  $('#accountsToolbar').innerHTML = '<span class="accounts-toolbar-title">Admin</span>';

  $('#accountsFeed').innerHTML = `
    <div class="acct-card">
      <div class="acct-section-title">Admin tools</div>
      <p style="color:var(--muted);font-size:14px;margin:0">Operational controls stay available here without adding a launch-user checkout surface.</p>
    </div>`;
}

// st_4e7e3aaf AC11 — Apple FDA flow. ONE button that opens the Full Disk
// Access settings pane directly via /api/accounts/open-settings — no shell
// snippet, no copy block. The conditional node-fallback note appears only
// when the server reports running_robot_dojo_runtime === false.
function showAppleFdaModal() {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay fda-modal-overlay';
  overlay.innerHTML = `
    <div class="confirm-modal fda-modal">
      <div class="fda-modal-header">
        <div>
          <div class="fda-modal-title">Grant Full Disk Access</div>
          <div class="fda-modal-subtitle">One click opens the macOS Privacy &amp; Security &gt; Full Disk Access pane. Find <strong>Robot Dojo</strong> in the list and turn it on.</div>
        </div>
        <button class="fda-modal-close" onclick="this.closest('.confirm-overlay').remove()" aria-label="Close">×</button>
      </div>
      <div class="fda-modal-body">
        <div class="fda-actions">
          <button type="button" class="acct-action-btn" onclick="openFullDiskAccessSettings()">
            <span class="material-symbols-outlined icon-sm">admin_panel_settings</span> Open Full Disk Access settings
          </button>
        </div>
        <ol class="fda-steps">
          <li>Click the button above. System Settings opens directly to Full Disk Access.</li>
          <li>Find <strong>Robot Dojo</strong> in the list and turn it on.</li>
          <li id="fdaNodeFallbackStep" style="display:none">If the list shows <strong>node</strong> instead of Robot Dojo, enable node.</li>
        </ol>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Conditionally show the node-fallback note only when the local runtime
  // is not the Robot Dojo app bundle. Fetch is non-blocking — the modal
  // frame paints instantly; the step toggles visible if the endpoint
  // reports running_robot_dojo_runtime === false.
  _silentFetchJSON('/api/accounts/local-permission-target').then((target) => {
    if (target && target.running_robot_dojo_runtime === false) {
      const step = document.getElementById('fdaNodeFallbackStep');
      if (step) step.style.display = '';
    }
  });
}
window.showAppleFdaModal = showAppleFdaModal;

// st_4e7e3aaf AC11 — fires the server-side open-settings handler.
// The pane key is a fixed string; never a raw URL from the client.
async function openFullDiskAccessSettings() {
  try {
    const res = await fetch('/api/accounts/open-settings?pane=full-disk-access');
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      showToast('Opened Full Disk Access');
      return;
    }
    showToast(`Open failed: ${data?.detail || 'unknown error'}`);
  } catch {
    showToast('Open failed');
  }
}
window.openFullDiskAccessSettings = openFullDiskAccessSettings;

// st_4e7e3aaf AC11 — Granola sign-in modal. Single primary button that
// opens the local Granola Mac app via /api/accounts/open-app. No
// /auth/granola click-through, no download link.
function showGranolaSignInModal() {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay fda-modal-overlay';
  overlay.innerHTML = `
    <div class="confirm-modal fda-modal">
      <div class="fda-modal-header">
        <div>
          <div class="fda-modal-title">Connect Granola</div>
          <div class="fda-modal-subtitle">Granola connects automatically the moment you sign in to the Mac app. Open Granola, sign in, and Robot Dojo will start reading your transcripts in the background.</div>
        </div>
        <button class="fda-modal-close" onclick="this.closest('.confirm-overlay').remove()" aria-label="Close">×</button>
      </div>
      <div class="fda-modal-body">
        <div class="fda-actions">
          <button type="button" class="acct-action-btn" onclick="openGranolaApp()">
            <span class="material-symbols-outlined icon-sm">add_link</span> Sign in to Granola
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window.showGranolaSignInModal = showGranolaSignInModal;

async function openGranolaApp() {
  try {
    const res = await fetch('/api/accounts/open-app?name=Granola');
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      showToast('Opening Granola');
      return;
    }
    showToast(`Granola not opened: ${data?.detail || 'unknown error'}`);
  } catch {
    showToast('Could not open Granola');
  }
}
window.openGranolaApp = openGranolaApp;

// ===== st_d9fc573b — Phase 2 helpers =====
