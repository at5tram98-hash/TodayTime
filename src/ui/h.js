// View layer: Preact + htm (vendored, no build step).
import { h, render, Fragment, createContext } from '../vendor/preact.mjs';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer } from '../vendor/hooks.mjs';
import htm from '../vendor/htm.mjs';

export const html = htm.bind(h);
export { h, render, Fragment, createContext, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer };
