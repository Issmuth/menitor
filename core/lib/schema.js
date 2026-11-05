// A small JSON Schema validator with no dependencies.
// It supports the subset of draft 2020-12 that Menitor's schemas use:
// type, const, enum, properties, required, additionalProperties, propertyNames,
// items, minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
// minimum, maximum, anyOf, and local $ref into #/$defs.

/**
 * @typedef {{ path: string, message: string }} SchemaError
 * @typedef {Record<string, any>} Schema
 */

/**
 * Validate a value against a schema.
 * @param {Schema} schema
 * @param {unknown} value
 * @returns {SchemaError[]} an empty array when the value is valid
 */
export function validate(schema, value) {
  /** @type {SchemaError[]} */
  const errors = [];
  check(schema, value, '$', schema, errors);
  return errors;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * @param {string} expected
 * @param {string} actual
 */
function typeMatches(expected, actual) {
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

/**
 * @param {Schema} root
 * @param {string} ref
 * @returns {Schema}
 */
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref values are supported, got ${ref}`);
  /** @type {any} */
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!node || typeof node !== 'object') throw new Error(`Unresolved $ref ${ref}`);
  return node;
}

/**
 * @param {string} base
 * @param {string} key
 */
function childPath(base, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/**
 * @param {Schema} schema
 * @param {any} value
 * @param {string} path
 * @param {Schema} root
 * @param {SchemaError[]} errors
 */
function check(schema, value, path, root, errors) {
  if (schema.$ref) {
    check(resolveRef(root, schema.$ref), value, path, root, errors);
    return;
  }

  if (schema.anyOf) {
    const passes = schema.anyOf.some((/** @type {Schema} */ s) => validateWith(s, value, path, root).length === 0);
    if (!passes) {
      // Report the branch the author most likely meant: one whose type matched, with the fewest errors.
      /** @param {SchemaError[]} errs */
      const score = (errs) => errs.length + (errs.some((e) => e.path === path && e.message.startsWith('must be ') && e.message.includes(', got ')) ? 1000 : 0);
      const attempts = schema.anyOf.map((/** @type {Schema} */ s) => validateWith(s, value, path, root));
      attempts.sort((a, b) => score(a) - score(b));
      errors.push(...attempts[0]);
    }
    return;
  }

  const actual = typeOf(value);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {string} */ t) => typeMatches(t, actual))) {
      errors.push({ path, message: `must be ${types.join(' or ')}, got ${actual}` });
      return;
    }
  }

  if ('const' in schema && value !== schema.const) {
    errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of ${schema.enum.map((/** @type {unknown} */ v) => JSON.stringify(v)).join(', ')}` });
  }

  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push({ path, message: `must match ${schema.pattern}` });
    }
  }

  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be at most ${schema.maximum}` });
    }
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((/** @type {unknown} */ item, /** @type {number} */ i) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push({ path: `${path}[${i}]`, message: 'duplicates an earlier item' });
        seen.add(key);
      });
    }
    if (schema.items) {
      value.forEach((/** @type {unknown} */ item, /** @type {number} */ i) => check(schema.items, item, `${path}[${i}]`, root, errors));
    }
  }

  if (actual === 'object') {
    const props = schema.properties ?? {};
    // Fields set to undefined are absent, as they are once written as JSON.
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push({ path: childPath(path, key), message: 'is required' });
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (schema.propertyNames) {
        for (const e of validateWith(schema.propertyNames, key, childPath(path, key), root)) {
          errors.push({ path: e.path, message: `key ${e.message}` });
        }
      }
      if (key in props) {
        check(props[key], child, childPath(path, key), root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath(path, key), message: 'is not an allowed field' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, child, childPath(path, key), root, errors);
      }
    }
  }
}

/**
 * @param {Schema} schema
 * @param {unknown} value
 * @param {string} path
 * @param {Schema} root
 */
function validateWith(schema, value, path, root) {
  /** @type {SchemaError[]} */
  const errors = [];
  check(schema, value, path, root, errors);
  return errors;
}

/**
 * Format schema errors as indented lines.
 * @param {SchemaError[]} errors
 */
export function formatErrors(errors) {
  return errors.map((e) => `  ${e.path} ${e.message}`).join('\n');
}
