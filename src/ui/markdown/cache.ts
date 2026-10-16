// Looks a value up, or makes and keeps it; past the limit the least recently used one goes.
export function remember<K, V extends object | boolean>(cache: Map<K, V>, limit: number, key: K, make: () => V): V {
  const value = cache.get(key) ?? make()
  cache.delete(key)
  cache.set(key, value)
  const oldest = cache.keys().next()
  if (cache.size > limit && !oldest.done) cache.delete(oldest.value)
  return value
}
