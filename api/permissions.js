const ROLES = ['admin', 'staff', 'client'];

function credentialRole(value, clientId) {
  const role = String(value || '').trim().toLowerCase();
  // Keep pre-Role logins working; explicit roles always take precedence over the account ID.
  return role || (clientId === 'CL-000' ? 'admin' : 'client');
}

function validSessionRole(session) {
  return Boolean(session) && ROLES.includes(session.role)
    && typeof session.clientId === 'string' && Boolean(session.clientId.trim())
    && !(session.role === 'client' && session.clientId === 'CL-000');
}

function warehouseAccess(session) {
  return validSessionRole(session) && ['admin', 'staff'].includes(session.role);
}

module.exports = { credentialRole, validSessionRole, warehouseAccess };
