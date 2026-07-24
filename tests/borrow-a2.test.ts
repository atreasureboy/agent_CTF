/**
 * Phase A2 — per-category toolset.
 */

import { describe, it, expect } from 'vitest'
import {
  BUILTIN_TOOLSETS,
  DEFAULT_CATEGORY_TOOLSET,
  categoryToolsAllowed,
  extractCategory,
} from '../src/core/toolBroker/categoryToolset.js'

describe('CategoryToolset (A2)', () => {
  it('extractCategory returns the right category', () => {
    expect(extractCategory({ category: 'web' })).toBe('web')
    expect(extractCategory({ category: 'CRYPTO' })).toBe('crypto')
    expect(extractCategory({})).toBe('misc')
    expect(extractCategory({ category: 'unknown' })).toBe('misc')
  })

  it('categoryToolsAllowed allows the right tools per category', () => {
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'web', 'webFetch')).toBe(true)
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'crypto', 'decompile')).toBe(true)
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'web', 'gdb')).toBe(false)
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'pwn', 'gdb')).toBe(true)
  })

  it('universal tools are allowed regardless of category', () => {
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'web', 'runCommand')).toBe(true)
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'reverse', 'runCommand')).toBe(true)
  })

  it('unknown categories default to misc', () => {
    expect(categoryToolsAllowed(DEFAULT_CATEGORY_TOOLSET, 'misc', 'strings')).toBe(true)
  })

  it('BUILTIN_TOOLSETS has all five categories', () => {
    expect(Object.keys(BUILTIN_TOOLSETS).sort()).toEqual(['crypto', 'misc', 'pwn', 'reverse', 'web'])
  })
})
