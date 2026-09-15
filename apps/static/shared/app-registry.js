(function () {
  const WEBSITE_SUBFLOWS = Object.freeze([
    { id: 'home', name: 'Home', path: '/' },
    { id: 'login', name: 'Login', path: '/login' },
    { id: 'faq', name: 'FAQ', path: '/#faq', aliases: ['/faq'] },
    { id: 'ask', name: 'Ask', path: '/ask' },
    { id: 'legal', name: 'Legal', paths: ['/privacy', '/terms', '/licensing'] },
    { id: 'install', name: 'Install', paths: ['/install-success', '/install.sh'] },
    { id: 'guidance', name: 'Guidance', paths: ['/auth-google-guidance', '/llms.txt', '/sitemap.xml'] },
  ]);

  const ACCOUNT_SUBFLOWS = Object.freeze([
    { id: 'how-to', name: 'How To Robot', path: '/account/how-to' },
    { id: 'general', name: 'Admin', path: '/account/general' },
    { id: 'integrations', name: 'Integrations', path: '/account/integrations' },
    { id: 'agents', name: 'Agents', path: '/account/agents' },
    { id: 'skills', name: 'Skills', path: '/account/skills' },
    { id: 'you', name: 'You', path: '/account/you' },
    { id: 'shortcuts', name: 'Shortcuts', path: '/account/shortcuts' },
    { id: 'setup', name: 'Setup', path: '/account/setup', hidden: true },
    { id: 'imports', name: 'Imports', path: '/account/imports', hidden: true },
  ]);

  const PRODUCT_APPS = Object.freeze([
    {
      slug: 'website',
      name: 'Website',
      use_case: 'Public website, login, FAQ, public Ask, legal pages, install guidance',
      icon: 'public',
      path: '/',
      belt: 'demo',
      surface: 'public',
      waffle: false,
      launch: false,
      routes: ['/', '/login', '/ask', '/faq', '/privacy', '/terms', '/licensing', '/install-success', '/auth-google-guidance', '/install.sh', '/llms.txt', '/sitemap.xml'],
      subflows: WEBSITE_SUBFLOWS,
    },
    { slug: 'chat', name: 'Chat', use_case: 'Conversation, assistance, and topic-centered work', icon: 'chat', path: '/chat', belt: 'white', surface: 'product', waffle: true, launch: true },
    { slug: 'podcast', name: 'Podcast', use_case: 'Turn articles, uploads, and long-form sources into private podcast episodes and series', icon: 'podcasts', path: '/podcast', belt: 'black', surface: 'product', waffle: true, launch: false, routes: ['/podcast', '/apps/podcast/'] },
    { slug: 'network', name: 'Network', use_case: 'Relationship and entity management', icon: 'hub', path: '/network', belt: 'black', surface: 'product', waffle: true, launch: false },
    { slug: 'health', name: 'Health', use_case: 'Personal health data review and notes', icon: 'favorite', path: '/health', belt: 'black', surface: 'product', waffle: true, launch: false },
    { slug: 'fitness', name: 'Fitness', use_case: 'Daily meals, training, and recovery', icon: 'exercise', path: '/fitness', belt: 'black', surface: 'product', waffle: true, launch: false },
    {
      slug: 'account',
      name: 'Account',
      use_case: 'Account management, setup, integrations, identity, and skills',
      icon: 'settings',
      path: '/account',
      belt: 'black',
      surface: 'system',
      waffle: false,
      launch: false,
      routes: ['/account', '/accounts', ...ACCOUNT_SUBFLOWS.map(flow => flow.path)],
      subflows: ACCOUNT_SUBFLOWS,
    },
  ]);

  const LOCKED_ON_WHITE = new Set(['podcast', 'network', 'health', 'fitness']);

  function sanitizeDescriptor(raw) {
    const out = {
      slug: String(raw?.slug || raw?.id || '').trim(),
      name: String(raw?.name || raw?.title || raw?.slug || raw?.id || '').trim(),
      use_case: raw?.use_case ? String(raw.use_case).trim() : undefined,
      icon: String(raw?.icon || 'dashboard').trim(),
      path: String(raw?.path || '').trim(),
      belt: String(raw?.belt || 'black').trim(),
      surface: String(raw?.surface || 'topic').trim(),
      waffle: Boolean(raw?.waffle),
      launch: Boolean(raw?.launch),
      routes: Array.isArray(raw?.routes) ? raw.routes.map(route => String(route)) : undefined,
      subflows: Array.isArray(raw?.subflows) ? raw.subflows.map(flow => ({
        id: String(flow.id || '').trim(),
        name: String(flow.name || flow.id || '').trim(),
        path: flow.path ? String(flow.path).trim() : undefined,
        paths: Array.isArray(flow.paths) ? flow.paths.map(path => String(path)) : undefined,
        aliases: Array.isArray(flow.aliases) ? flow.aliases.map(path => String(path)) : undefined,
        hidden: flow.hidden === true,
      })) : undefined,
    };
    out.locked_on_white = Boolean(raw?.locked_on_white) || LOCKED_ON_WHITE.has(out.slug);
    return out;
  }

  function listProductApps(options = {}) {
    const includeHidden = options.includeHidden === true;
    return PRODUCT_APPS
      .filter(app => includeHidden || app.waffle)
      .map(sanitizeDescriptor);
  }

  function listWaffleApps(options = {}) {
    const founder = options.founder === true;
    return PRODUCT_APPS
      .filter(app => app.waffle && (founder || app.launch === true))
      .map(sanitizeDescriptor);
  }

  window.RobotDojoAppRegistry = {
    listProductApps,
    listWaffleApps,
    sanitizeDescriptor,
  };
})();
