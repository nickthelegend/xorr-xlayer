/**
 * The repository container — PLAN.md §3.8.
 *
 * Screens call `repos.markets.listClasses()`, never `fetch`. Swapping the implementation
 * (fixtures -> API) changes this file only.
 */
import { LocalRepositories } from './local';
import type { Repositories } from './repositories';

export const repos: Repositories = LocalRepositories;

export * from './types';
export * from './repositories';
