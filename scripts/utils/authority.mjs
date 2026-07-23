/**
 * Return the first active GM in Foundry's stable User collection order.
 *
 * @param {Collection<User>|User[]|null|undefined} users User collection.
 * @returns {User|object|null}
 */
export function firstActiveGm(users = globalThis.game?.users) {
  if (!users) return null;
  if (typeof users.find === "function") {
    return users.find(user => user?.active === true && user?.isGM === true) ?? null;
  }
  const values = typeof users.values === "function"
    ? Array.from(users.values())
    : Array.from(users ?? []);
  return values.find(user => user?.active === true && user?.isGM === true) ?? null;
}

/**
 * Whether the current client is the one active GM selected for observer work.
 *
 * @param {User|object|null|undefined} user Current user.
 * @param {Collection<User>|User[]|null|undefined} users User collection.
 * @returns {boolean}
 */
export function isAuthoritativeGmClient(
  user = globalThis.game?.user,
  users = globalThis.game?.users
) {
  if (user?.isGM !== true) return false;
  const authoritative = firstActiveGm(users);
  return !authoritative || authoritative.id === user.id;
}
