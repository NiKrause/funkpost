// SPDX-License-Identifier: GPL-3.0-only
/**
 * What mesh-heartbeat says, in both languages.
 *
 * Written for somebody who arrived here and nowhere else. The intro used to
 * open "two nodes and no list", which is only a sentence if you already know
 * the demo next door carries a todo list — and the people this page is for do
 * not. A page that measures a radio has to explain itself without the
 * neighbours.
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
      "Two Meshtastic nodes and nothing else: no database, nothing to replicate, nothing to keep in step. One stays put and answers; the other goes for a ride and asks. What comes back is not <em>the mesh works</em> but a place with an answer or a silence against it — and, when it answered, on which beat.",

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
      airUtil: (pct) => `air used by this node: ${pct}%`,
      awake: "Keep the screen awake",
      awakeWhy:
        "Web Bluetooth pauses when the screen locks: the node stays connected and the page stops being able to talk to it. On a ride nobody is there to keep the screen alive.",
    },

    errors: {
      gaveUp: "the node did not come back — reload to connect again",
    },

    led: {
      out: "beat out",
      outIdle: "nothing sent yet",
      outAt: (n, of, time) => `beat ${n} of ${of} · ${time}`,
      // The stationary device sends nothing but echoes, so its lamp has to
      // name one — otherwise the half of the experiment whose only job is to
      // answer has no way of showing that it did.
      outAnswer: "answer out",
      outEcho: (to, n, time) => `echo to ${to} · answers beat ${n} · ${time}`,
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

    // The stationary device's own record. Deliberately not the same shape as
    // the ride: it knows what arrived, not where the other device was.
    heard: {
      legend: "What reached this device",
      empty: "Nothing yet. A row appears when a beat arrives.",
      summary: ({ heard, answered, askers, echoes, located }) =>
        `${heard} ${plural(heard, "beat", "beats")} heard · ${answered} answered · ${located} with a place · from ${askers} ${plural(askers, "device", "devices")}` +
        (echoes ? ` · ${echoes} other ${plural(echoes, "echo", "echoes")} on the channel` : ""),
      beat: (n) => (n ? `beat ${n}` : "beat"),
      foreign: "somebody else's echo",
      yes: "answered",
      no: "not answered",
      clear: "Clear what was heard",
      note: "A place arrives on the first beat of each round, so the beats in between have none rather than repeating the last one. The device that stays announces its own position once.",
      columns: {
        time: "time",
        from: "from",
        what: "what",
        bytes: "size",
        place: "where it was",
        distance: "from here",
        answered: "our answer",
      },
    },

    // The same ride on both screens (#184). OpenStreetMap, no Google.
    map: {
      legend: "The ride on a map",
      empty: "Nothing to draw yet: a point appears when a beat goes out with a place against it.",
      station: "the device that stays",
      here: "this device",
      recentre: "Back to the ride",
      offline: "No map tiles — there is no internet here. The line, the dots and the distance are drawn from numbers this device already holds.",
      note: "Green answered at once, amber answered later, red not at all. The dashed line is the link being measured right now. Map data © OpenStreetMap contributors.",
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
      region: (name) => `node region ${name}`,
      nodeStatus: (name) => `node ${name}`,
      nodeChannel: (index, name, print) => `channel ${index} »${name}« ⌗${print}`,
      autoChannel: (index, name, print) => `→ channel ${index} »${name}« ⌗${print} (preferred)`,
      handChannel: (index, name, print) => `→ channel ${index} »${name}« ⌗${print} (chosen)`,
      linkDropped: (n) => `link dropped — repair ${n}`,
      reconnected: "link back",
      gaveUp: "✗ the node did not come back",
      wakeOn: "screen kept awake",
      wakeOff: "screen may sleep again",
      wakeRefused: (why) => `the screen lock was refused: ${why}`,
      gattQueueOn: "one Bluetooth operation at a time",
      windowError: (type, message) => `! window ${type}: ${message}`,
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
      "Zwei Meshtastic-Knoten und sonst nichts: keine Datenbank, nichts zu replizieren, nichts abzugleichen. Einer bleibt stehen und antwortet, der andere fährt und fragt. Zurück kommt nicht <em>das Mesh funktioniert</em>, sondern ein Ort mit einer Antwort oder einem Schweigen daneben — und wenn geantwortet wurde, auf welchem Beat.",

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
      airUtil: (pct) => `von diesem Knoten belegte Sendezeit: ${pct} %`,
      awake: "Bildschirm wach halten",
      awakeWhy:
        "Web Bluetooth pausiert, sobald der Bildschirm sperrt: der Knoten bleibt verbunden, und die Seite kann nicht mehr mit ihm reden. Auf einer Fahrt hält niemand den Bildschirm wach.",
    },

    errors: {
      gaveUp: "der Knoten kam nicht zurück — neu laden zum Verbinden",
    },

    led: {
      out: "Beat raus",
      outIdle: "noch nichts gesendet",
      outAt: (n, of, time) => `Beat ${n} von ${of} · ${time}`,
      outAnswer: "Antwort raus",
      outEcho: (to, n, time) => `echo an ${to} · beantwortet Beat ${n} · ${time}`,
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

    heard: {
      legend: "Was hier ankam",
      empty: "Noch nichts. Eine Zeile erscheint, wenn ein Beat ankommt.",
      summary: ({ heard, answered, askers, echoes, located }) =>
        `${heard} ${plural(heard, "Beat", "Beats")} gehört · ${answered} beantwortet · ${located} mit Ort · von ${askers} ${plural(askers, "Gerät", "Geräten")}` +
        (echoes ? ` · ${echoes} fremde ${plural(echoes, "Antwort", "Antworten")} auf dem Kanal` : ""),
      beat: (n) => (n ? `Beat ${n}` : "Beat"),
      foreign: "fremdes Echo",
      yes: "beantwortet",
      no: "nicht beantwortet",
      clear: "Empfangenes löschen",
      note: "Ein Ort kommt auf dem ersten Beat jeder Runde, die Beats dazwischen haben keinen — statt den letzten zu wiederholen. Das stehende Gerät sagt einmal, wo es selbst steht.",
      columns: {
        time: "Zeit",
        from: "von",
        what: "was",
        bytes: "Größe",
        place: "wo es war",
        distance: "von hier",
        answered: "unsere Antwort",
      },
    },

    map: {
      legend: "Die Fahrt auf der Karte",
      empty: "Noch nichts zu zeichnen: ein Punkt erscheint, wenn ein Beat mit Ort rausgeht.",
      station: "das Gerät, das bleibt",
      here: "dieses Gerät",
      recentre: "Zurück zur Fahrt",
      offline: "Keine Kartenkacheln — hier ist kein Internet. Linie, Punkte und Entfernung werden aus Zahlen gezeichnet, die dieses Gerät schon hat.",
      note: "Grün sofort beantwortet, gelb später, rot gar nicht. Die gestrichelte Linie ist die Verbindung, die gerade gemessen wird. Kartendaten © OpenStreetMap-Mitwirkende.",
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
      region: (name) => `Knotenregion ${name}`,
      nodeStatus: (name) => `Knoten ${name}`,
      nodeChannel: (index, name, print) => `Kanal ${index} »${name}« ⌗${print}`,
      autoChannel: (index, name, print) => `→ Kanal ${index} »${name}« ⌗${print} (bevorzugt)`,
      handChannel: (index, name, print) => `→ Kanal ${index} »${name}« ⌗${print} (gewählt)`,
      linkDropped: (n) => `Verbindung weg — Reparatur ${n}`,
      reconnected: "Verbindung wieder da",
      gaveUp: "✗ der Knoten kam nicht zurück",
      wakeOn: "Bildschirm wird wach gehalten",
      wakeOff: "Bildschirm darf wieder schlafen",
      wakeRefused: (why) => `die Bildschirmsperre wurde verweigert: ${why}`,
      gattQueueOn: "immer nur eine Bluetooth-Operation gleichzeitig",
      windowError: (type, message) => `! Fenster ${type}: ${message}`,
      position: (source, text) => `Position (${source}) ${text}`,
      officePosition: (text) => `das andere Gerät steht bei ${text}`,
      error: (message) => `Fehler: ${message}`,
    },

    footer: (info) => `funkpost ${info.version} · ${info.commit} · gebaut ${info.builtAt}`,
  },
};
