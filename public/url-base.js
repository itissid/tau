const INSTANCE_ROUTE = /^\/i\/([1-9]\d*)(?:\/|$)/;

function browserLocation(locationLike) {
  const value = locationLike ?? globalThis.location;
  if (!value) throw new Error('A browser location is required');
  return value;
}

export function instancePid(pathname = browserLocation().pathname) {
  const match = INSTANCE_ROUTE.exec(pathname);
  return match ? Number(match[1]) : null;
}

export function instanceBasePath(pathname = browserLocation().pathname) {
  const pid = instancePid(pathname);
  return pid === null ? '' : `/i/${pid}`;
}

export function instancePath(resource = '', pathname = browserLocation().pathname) {
  const relative = String(resource).replace(/^\/+/, '');
  const base = instanceBasePath(pathname);
  return relative ? `${base}/${relative}` : `${base}/`;
}

export function apiPath(resource = '', pathname = browserLocation().pathname) {
  const relative = String(resource).replace(/^\/+/, '');
  return instancePath(relative ? `api/${relative}` : 'api/', pathname);
}

export function currentWebSocketUrl(locationLike) {
  const locationValue = browserLocation(locationLike);
  const protocol = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationValue.host}${instancePath('ws', locationValue.pathname)}`;
}

export function instancePagePath(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid Tau instance PID: ${pid}`);
  return `/i/${pid}/`;
}

export function instanceWebSocketUrl(instance, locationLike) {
  const locationValue = browserLocation(locationLike);
  const protocol = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';

  if (instancePid(locationValue.pathname) !== null) {
    return `${protocol}//${locationValue.host}${instancePagePath(instance.pid)}ws`;
  }

  return `${protocol}//${locationValue.hostname}:${instance.port}/ws`;
}
