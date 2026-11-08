import { createContext, useContext } from 'react';

/**
 * The signed-in user, shared with every screen.
 *
 * App already knows who is signed in before it renders anything, so having
 * each Layout ask the server again was both a wasted request and a visible
 * bug: the sidebar rendered the admin menu first and collapsed to one entry
 * when the answer came back, so a viewer saw a flash of screens they cannot
 * open.
 */
const SessionContext = createContext(null);

export const SessionProvider = SessionContext.Provider;

export function useSession() {
  return useContext(SessionContext);
}
