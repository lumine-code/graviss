const sessions = new WeakMap();

function retainSession(session) {
  const ownership = sessions.get(session) || { references: 0 };
  sessions.set(session, ownership);
  ownership.references++;
  let released = false;
  return {
    dispose() {
      if (released) return;
      released = true;
      ownership.references--;
      if (ownership.references === 0) {
        sessions.delete(session);
        session.dispose();
      }
    },
  };
}

module.exports = { retainSession };
