// I5: nothing secret is ever written into a vault. Every JSON write goes through this check.

// Matched anywhere in a key, ignoring case: catches `openaiApiKey`, `x-api-key`, `apiKeys`, `refreshToken`.
const SECRET_KEY = /api[-_]?key|secret|token|password|authorization|bearer/i;

/** Throws if `value` contains an object key that names a secret, at any depth. */
export function assertNoSecrets(value: unknown, path = '$'): void {
	if (Array.isArray(value)) {
		value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
	} else if (value !== null && typeof value === 'object') {
		for (const [key, v] of Object.entries(value)) {
			if (SECRET_KEY.test(key)) throw new Error(`refusing to write a secret into the vault: ${path}.${key}`);
			assertNoSecrets(v, `${path}.${key}`);
		}
	}
}
