const LOCAL_QA_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function assertRelayQaUrl(rawUrl, source = 'QA_BASE_URL') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${source} must be an absolute relay URL, got: ${rawUrl}`);
  }

  const host = url.hostname.toLowerCase();
  if (LOCAL_QA_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error(`${source} must use the live relay, not localhost/127.0.0.1: ${rawUrl}`);
  }

  if (!host.endsWith('robotdojo.ai')) {
    throw new Error(`${source} must target robotdojo.ai relay traffic: ${rawUrl}`);
  }

  return url.toString().replace(/\/$/, '');
}
