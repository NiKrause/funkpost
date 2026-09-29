// SPDX-License-Identifier: GPL-3.0-only
/**
 * What mesh-heartbeat says, in both languages.
 *
 * German without address, as on lora.le-space.de: no du, no Sie. Protocol
 * names — beat, echo — stay as the wire spells them, in both languages, so a
 * log line and a field note can be compared without translating either.
 */
const plural = (n, one, many) => (n === 1 ? one : many);

export const WORDS = {
  en: {
    title: "mesh-heartbeat — how far does the mesh reach?",
    tagline: "one device stays · one travels · every beat recorded with where it went out",
    intro:
      "Two Meshtastic nodes and no list. One stays put and answers; the other goes for a ride and asks. What comes back is not <em>the mesh works</em> but a place with an answer or a silence against it — and, when it answered, on which beat.",

    role: {
      legend: "What this device does",
      office: "Stays here and answers",
      officeWhy: "Answers whatever it hears, and asks nothing. Announces where it is, once.",
      rider: "Travels and asks",
      riderWhy: "Sends a round every so often and records what comes back, with the position.",
    },

    interval: {
      legend: "How often to ask",
      off: "Only when asked",
      minutes: (n) => `every ${n} min`,
      cost: (perRound, perHour, share) =>
        `at most ${perRound} B a round, ${perHour} an hour — about ${share}% of what this carrier was measured to move (~500 B a minute)`,
      note: "A round is three beats 15 s apart, and it ends at the first answer — so a good spot costs one beat, not three.",
    },

    send: "Ask now",
    sending: "asking…",

    radio: {
      legend: "The radio",
      connect: "Connect a Meshtastic® node",
      connecting: "connecting…",
      connected: (region) => `node connected · ${region}`,
      fake: "Fake mesh (this browser)",
      fakeOn: "fake mesh · two tabs talk to each other",
      none: "no node connected",
      lost: "node lost — reload to reconnect",
      reconnecting: "node dropped — reconnecting…",
      unset: "the node has no region set — it will not transmit",
      channel: "Channel",
    },

    led: {
      out: "beat out",
      outIdle: "nothing sent yet",
      outAt: (n, of, time) => `beat ${n} of ${of} · ${time}`,
      in: "heard",
      inIdle: "nothing heard yet",
      // An echo answers a beat; a beat *is* one. Saying "answers beat 1" of an
      // incoming beat — which the stationary device sees all day — describes
      // the wrong direction of the conversation.
      inAt: (type, from, n, bytes, time) =>
        `${type} from ${from}${n ? (type === "echo" ? ` · answers beat ${n}` : ` · beat ${n}`) : ""} · ${bytes} B · ${time}`,
    },

    partner: {
      legend: "Whose answer counts",
      anyone: "anyone who answers",
      hint: "A channel is shared. Everyone running this app with the same question hears everyone else, so a stranger's node can answer a beat — and the track would then show their coverage as this device's. Pick the other device once it has been heard, and only its answers count. A channel of your own separates the data completely; it does not separate the airtime, which everyone on the frequency shares either way.",
      shared: (n) => `${n} different devices have answered — this channel is shared`,
    },

    where: {
      legend: "Where this is",
      node: "from the node",
      browser: "from the browser",
      none: "no fix yet",
      waiting: "beats are still recorded, just without a place",
      office: "The other device says it is at",
      officeNone: "the other device has not said where it is",
    },

    track: {
      legend: "The ride",
      empty: "No beats yet. Nothing here is made up: a row appears when one goes out.",
      answered: (n) => (n === 1 ? "answered at once" : `answered on beat ${n}`),
      silent: "no answer",
      waiting: "waiting…",
      clear: "Clear the track",
      confirmClear: "Clear every recorded beat? This cannot be undone.",
      summary: ({ sent, reached, firstBeat, located }) =>
        `${sent} ${plural(sent, "beat", "beats")} · ${reached} answered · ${firstBeat} at once · ${located} with a place`,
      columns: {
        time: "time",
        place: "place",
        distance: "from the other device",
        result: "result",
        by: "answered by",
      },
    },

    log: {
      legend: "Field log",
      beat: (n, of) => `→ beat ${n}/${of}`,
      heard: (type, from, n, bytes) =>
        `← ${type} from ${from}${n ? ` (beat ${n})` : ""} ${bytes ?? "?"} B`,
      echo: (to, n) => `→ echo to ${to}${n ? ` (beat ${n})` : ""}`,
      alone: "✗ no answer this round",
      started: (role) => `heartbeat started · ${role}`,
      stopped: "heartbeat stopped",
      position: (source, text) => `position (${source}) ${text}`,
      officePosition: (text) => `the other device is at ${text}`,
      error: (message) => `error: ${message}`,
    },

    footer: (info) => `funkpost ${info.version} · ${info.commit} · built ${info.builtAt}`,
  },

  de: {
    title: "mesh-heartbeat — wie weit reicht das Mesh?",
    tagline: "ein Gerät bleibt · eines fährt · jeder Beat mit dem Ort festgehalten",
    intro:
      "Zwei Meshtastic-Knoten und keine Liste. Einer bleibt stehen und antwortet, der andere fährt und fragt. Zurück kommt nicht <em>das Mesh funktioniert</em>, sondern ein Ort mit einer Antwort oder einem Schweigen daneben — und wenn geantwortet wurde, auf welchem Beat.",

    role: {
      legend: "Was dieses Gerät tut",
      office: "Bleibt hier und antwortet",
      officeWhy: "Antwortet auf alles, was es hört, und fragt nichts. Sagt einmal, wo es steht.",
      rider: "Fährt und fragt",
      riderWhy: "Sendet in Abständen eine Runde und hält fest, was zurückkommt — mit Position.",
    },

    interval: {
      legend: "Wie oft gefragt wird",
      off: "Nur auf Knopfdruck",
      minutes: (n) => `alle ${n} min`,
      cost: (perRound, perHour, share) =>
        `höchstens ${perRound} B je Runde, ${perHour} je Stunde — rund ${share}% dessen, was dieser Träger gemessen schafft (~500 B je Minute)`,
      note: "Eine Runde sind drei Beats im Abstand von 15 s, und sie endet bei der ersten Antwort — eine gute Stelle kostet also einen Beat, nicht drei.",
    },

    send: "Jetzt fragen",
    sending: "fragt…",

    radio: {
      legend: "Das Funkgerät",
      connect: "Meshtastic®-Knoten verbinden",
      connecting: "verbindet…",
      connected: (region) => `Knoten verbunden · ${region}`,
      fake: "Fake-Mesh (dieser Browser)",
      fakeOn: "Fake-Mesh · zwei Tabs reden miteinander",
      none: "kein Knoten verbunden",
      lost: "Knoten verloren — neu laden zum Verbinden",
      reconnecting: "Knoten weg — verbindet neu…",
      unset: "der Knoten hat keine Region — er sendet nicht",
      channel: "Kanal",
    },

    led: {
      out: "Beat raus",
      outIdle: "noch nichts gesendet",
      outAt: (n, of, time) => `Beat ${n} von ${of} · ${time}`,
      in: "gehört",
      inIdle: "noch nichts gehört",
      inAt: (type, from, n, bytes, time) =>
        `${type} von ${from}${n ? (type === "echo" ? ` · antwortet auf Beat ${n}` : ` · Beat ${n}`) : ""} · ${bytes} B · ${time}`,
    },

    partner: {
      legend: "Wessen Antwort zählt",
      anyone: "wer auch immer antwortet",
      hint: "Ein Kanal ist geteilt. Alle, die diese App mit derselben Frage laufen lassen, hören einander — der Knoten eines Fremden kann also einen Beat beantworten, und die Fahrt zeigte dessen Abdeckung als die dieses Geräts. Das andere Gerät auswählen, sobald es gehört wurde, dann zählen nur dessen Antworten. Ein eigener Kanal trennt die Daten vollständig; die Sendezeit trennt er nicht, die teilen sich alle auf der Frequenz ohnehin.",
      shared: (n) => `${n} verschiedene Geräte haben geantwortet — dieser Kanal ist geteilt`,
    },

    where: {
      legend: "Wo das hier ist",
      node: "vom Knoten",
      browser: "vom Browser",
      none: "noch keine Position",
      waiting: "Beats werden trotzdem festgehalten, nur ohne Ort",
      office: "Das andere Gerät steht bei",
      officeNone: "das andere Gerät hat nicht gesagt, wo es steht",
    },

    track: {
      legend: "Die Fahrt",
      empty: "Noch keine Beats. Hier steht nichts Erfundenes: eine Zeile erscheint, wenn einer rausgeht.",
      answered: (n) => (n === 1 ? "sofort beantwortet" : `auf Beat ${n} beantwortet`),
      silent: "keine Antwort",
      waiting: "wartet…",
      clear: "Fahrt löschen",
      confirmClear: "Alle festgehaltenen Beats löschen? Das lässt sich nicht rückgängig machen.",
      summary: ({ sent, reached, firstBeat, located }) =>
        `${sent} ${plural(sent, "Beat", "Beats")} · ${reached} beantwortet · ${firstBeat} sofort · ${located} mit Ort`,
      columns: {
        time: "Zeit",
        place: "Ort",
        distance: "zum anderen Gerät",
        result: "Ergebnis",
        by: "beantwortet von",
      },
    },

    log: {
      legend: "Feldprotokoll",
      beat: (n, of) => `→ Beat ${n}/${of}`,
      heard: (type, from, n, bytes) =>
        `← ${type} von ${from}${n ? ` (Beat ${n})` : ""} ${bytes ?? "?"} B`,
      echo: (to, n) => `→ echo an ${to}${n ? ` (Beat ${n})` : ""}`,
      alone: "✗ keine Antwort in dieser Runde",
      started: (role) => `Heartbeat gestartet · ${role}`,
      stopped: "Heartbeat gestoppt",
      position: (source, text) => `Position (${source}) ${text}`,
      officePosition: (text) => `das andere Gerät steht bei ${text}`,
      error: (message) => `Fehler: ${message}`,
    },

    footer: (info) => `funkpost ${info.version} · ${info.commit} · gebaut ${info.builtAt}`,
  },
};
