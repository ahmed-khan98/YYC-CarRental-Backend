export function runInBackground(label, task) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error(`${label} failed:`, err?.message || err);
      });
  });
}
