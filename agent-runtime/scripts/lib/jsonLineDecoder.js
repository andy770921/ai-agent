// Streams chunks of text in, calls onLine(rawLine) for every newline-
// terminated line. Cross-chunk lines reassemble correctly. Blank lines
// are skipped. Malformed JSON is the caller's problem.

function createJsonLineDecoder(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    },
  };
}

module.exports = { createJsonLineDecoder };
