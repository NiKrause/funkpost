// SPDX-License-Identifier: GPL-3.0-only
/**
 * What mesh-trail says, in both languages.
 *
 * German without address, as on lora.le-space.de: no du, no Sie. Written for
 * somebody who arrived here and nowhere else — the demos next door are not
 * context a reader has.
 */
const plural = (n, one, many) => (n === 1 ? one : many);

export const WORDS = {
  en: {
    /* The jump bar. Short on purpose: these are pills in a row that
       scrolls sideways on a phone, and a card's own legend is a sentence. */
    jump: {
      label: "Jump to a part of this page",
      radio: "Radio",
      broadcast: "Sending",
      interval: "Interval",
      show: "Showing",
      "check-in": "State",
      hunt: "Fox",
      compass: "Compass",
      where: "Where",
      map: "Map",
      people: "People",
    },
    title: "mesh-trail — everyone on one map",
    tagline: "each device says where it is · every other device draws the trail",
    intro:
      "A walk with radios. Each device says where it is on a schedule, every other device hears it and draws the trail, and the arrow is which way that person was going when they were last heard. No internet involved — the positions cross a LoRa® mesh.",

    broadcast: {
      holdStale: "Say nothing when the fix is old",
      holdStaleWhy: "Off: a place this device has not left is still true, and silence would take it off everyone's map. On: better quiet than a place already left — for a phone that keeps walking while its browser stops answering.",
      legend: "Saying where I am",
      off: "Not sending. This device listens and draws, and nobody hears it.",
      on: "Sending my position",
      why: "Everything else here works without it: a device that only listens still sees the others.",
      publicWarning:
        "This is the published test channel. Its key is on a web page, so anyone who has read that page can see where you are, in real time, as you walk.",
      publicAsk: "Send my position on this public channel anyway",
      ownChannel: "A channel of your own takes one command: npm run channel.",
    },

    interval: {
      legend: "How often",
      off: "Only when asked",
      minutes: (n) => `every ${n} min`,
      cost: (people, perHour, share) =>
        `${people} ${plural(people, "device", "devices")} at this interval is about ${perHour} B an hour — ${share}% of what this carrier was measured to move`,
      crowded:
        "Past about half the carrier, a LoRa channel starts losing messages to collisions rather than to distance. A longer interval is the fix; there is no other one.",
      note: "The interval follows the group size. Two people can afford a minute; ten cannot.",
    },

    send: "Say where I am now",

    radio: {
      legend: "The radio",
      connect: "Connect a Meshtastic® node",
      disconnect: "Let the node go",
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
        "Web Bluetooth pauses when the screen locks: the node stays connected and the page stops being able to talk to it. In a pocket nobody notices.",
    },

    errors: {
      gaveUp: "the node did not come back — reload to connect again",
    },

    where: {
      legend: "Where this is",
      node: "from the node",
      browser: "from the browser",
      none: "no fix yet",
      waiting: "the others are still drawn; this device simply is not on the map",
      accuracy: (metres) => `±${metres} m`,
      age: (seconds) => (seconds < 2 ? "just now" : `${seconds} s ago`),
      stale: "out of date",
      held: (seconds) =>
        `Nothing has gone out: this fix is ${seconds} s old, and a beacon carries no time — the others would draw it as current. The phone reports a position when it changes, so standing still is quiet.`,
      ask: "Ask for my location",
      trouble: {
        searching:
          "Looking for a fix — nothing yet. Without a SIM the receiver has no assistance data and reads the satellites' own almanac, which takes minutes and needs a view of the sky.",
        denied:
          "This page is blocked from using your location. A button cannot undo that — allow it in the browser's settings for this site.",
        unavailable:
          "The receiver answered with nothing. Indoors that is the normal answer: without network location only satellites are left.",
        unsupported:
          "This browser offers no location here. A page served over plain HTTP cannot ask for one — it is a secure-context feature.",
      },
    },

    people: {
      legend: "Who is out there",
      empty: "Nobody heard yet. A row appears when a device says where it is.",
      summary: ({ heard, shown, moving }) =>
        `${heard} ${plural(heard, "device", "devices")} heard · ${shown} drawn · ${moving} moving`,
      you: "this device",
      namePlaceholder: "a name for this device",
      nameWhy: "Names stay on this phone and never go on the air.",
      lastHeard: (text) => `heard ${text}`,
      heading: (point, metres) => `${point}, ${metres}`,
      show: "Draw",
      forget: "Forget",
      confirmForget: "Forget this device and its trail?",
    },

    map: {
      legend: "The walk",
      empty: "Nothing to draw yet: a trail appears when a device says where it is.",
      station: "this device",
      here: "this device",
      recentre: "Fit everyone in",
      offline:
        "No map tiles — there is no internet here. The trails, the distances and the directions are drawn from numbers this device already holds.",
      note: "Each device has its own colour; the brighter end of a trail is the newer one. Map data © OpenStreetMap contributors.",
    },

    // A check-in, a game, a compass — and the switches that hide any of them.
    checkIn: {
      legend: "How I am",
      why: "Said at once, not at the next tick — that is the point of pressing it. Press it again to go back to fine.",
      states: { ok: "Fine", wait: "Stopping here", come: "Come to me", help: "Help" },
      mine: (state) => `This device says: ${state}`,
    },

    compass: {
      legend: "Which way",
      none: "Pick somebody in the list, and this says how far and which way.",
      noPlace: "This device has no position yet, so it cannot work out a direction.",
      line: (name, point, metres) => `${name} · ${point} · ${metres}`,
      age: (text) => `that position is ${text}`,
      stale: "Old enough to be somewhere else by now.",
      follow: "Follow",
      stop: "Stop following",
    },

    hunt: {
      legend: "Fox hunt",
      why: "One device is the fox and says where it is rarely; everyone else goes looking. The compass above points at the fox while a hunt is on.",
      iAmFox: "I am the fox",
      foxHeard: (name) => `the fox is ${name}`,
      noFox: "No fox heard yet.",
      slower: "A fox on a long interval is the game; a fox every minute is a walk with extra steps.",
    },

    show: {
      legend: "What this page shows",
      why: "A walk and a bench want different screens. Kept on this device.",
      map: "The map",
      trails: "Trails, not just where everyone is now",
      people: "Who is out there",
      compass: "Which way",
      checkIn: "How I am",
      hunt: "Fox hunt",
    },

    log: {
      legend: "Field log",
      sent: (bytes) => `→ my position (${bytes} B)`,
      heard: (from, bytes) => `← ${from} (${bytes} B)`,
      ignored: (why) => `· ignored: ${why}`,
      nodeStatus: (name) => `node ${name}`,
      region: (name) => `node region ${name}`,
      nodeChannel: (index, name, print) => `channel ${index} »${name}« ⌗${print}`,
      autoChannel: (index, name, print) => `→ channel ${index} »${name}« ⌗${print} (preferred)`,
      handChannel: (index, name, print) => `→ channel ${index} »${name}« ⌗${print} (chosen)`,
      linkDropped: (n) => `link dropped — repair ${n}`,
      reconnected: "link back",
      gaveUp: "✗ the node did not come back",
      wakeOn: "screen kept awake",
      wakeOff: "screen may sleep again",
      wakeRefused: (why) => `the screen lock was refused: ${why}`,
      position: (source, text, accuracy) =>
        `position (${source}) ${text}${Number.isFinite(accuracy) ? ` ±${Math.round(accuracy)} m` : ""}`,
      heldBack: (seconds) => `nothing said — the fix is ${seconds} s old`,
      noFix: (kind, message) => `! no position (${kind})${message ? `: ${message}` : ""}`,
      broadcastOn: "sending my position from now on",
      broadcastOff: "no longer sending my position",
      checkIn: (state) => `· I am ${state}`,
      foxOn: "· I am the fox",
      foxOff: "· no longer the fox",
      windowError: (type, message) => `! window ${type}: ${message}`,
      gattQueueOn: "one Bluetooth operation at a time",
      error: (message) => `error: ${message}`,
      disconnected: "node let go",
    },

    footer: (info) => `funkpost ${info.version} · ${info.commit} · built ${info.builtAt}`,
  },

  de: {
    /* The jump bar. Short on purpose: these are pills in a row that
       scrolls sideways on a phone, and a card's own legend is a sentence. */
    jump: {
      label: "Zu einem Teil dieser Seite springen",
      radio: "Funk",
      broadcast: "Senden",
      interval: "Takt",
      show: "Anzeigen",
      "check-in": "Zustand",
      hunt: "Fuchs",
      compass: "Kompass",
      where: "Wo",
      map: "Karte",
      people: "Leute",
    },
    title: "mesh-trail — alle auf einer Karte",
    tagline: "jedes Gerät sagt, wo es ist · jedes andere zeichnet die Spur",
    intro:
      "Ein Spaziergang mit Funkgeräten. Jedes Gerät sagt im Takt, wo es ist, jedes andere hört es und zeichnet die Spur, und der Pfeil zeigt, wohin die Person unterwegs war, als sie zuletzt gehört wurde. Kein Internet beteiligt — die Positionen gehen über ein LoRa®-Mesh.",

    broadcast: {
      holdStale: "Nichts sagen, wenn die Position alt ist",
      holdStaleWhy: "Aus: Ein Ort, den dieses Gerät nicht verlassen hat, stimmt weiterhin, und Schweigen nähme es von allen Karten. An: lieber still als ein längst verlassener Ort — für ein Telefon, das weiterläuft, während sein Browser nicht mehr antwortet.",
      legend: "Sagen, wo ich bin",
      off: "Sendet nicht. Dieses Gerät hört zu und zeichnet, und niemand hört es.",
      on: "Meine Position senden",
      why: "Alles andere hier geht auch ohne: ein Gerät, das nur zuhört, sieht die anderen trotzdem.",
      publicWarning:
        "Das ist der veröffentlichte Testkanal. Sein Schlüssel steht auf einer Webseite — wer die gelesen hat, sieht in Echtzeit, wo jemand geht.",
      publicAsk: "Position trotzdem auf diesem öffentlichen Kanal senden",
      ownChannel: "Ein eigener Kanal ist ein Befehl: npm run channel.",
    },

    interval: {
      legend: "Wie oft",
      off: "Nur auf Knopfdruck",
      minutes: (n) => `alle ${n} min`,
      cost: (people, perHour, share) =>
        `${people} ${plural(people, "Gerät", "Geräte")} in diesem Takt sind rund ${perHour} B je Stunde — ${share}% dessen, was dieser Träger gemessen schafft`,
      crowded:
        "Jenseits der halben Trägerleistung verliert ein LoRa-Kanal Nachrichten an Kollisionen statt an Entfernung. Dagegen hilft ein längerer Takt, und sonst nichts.",
      note: "Der Takt folgt der Gruppengröße. Zwei Leute können sich eine Minute leisten, zehn nicht.",
    },

    send: "Jetzt sagen, wo ich bin",

    radio: {
      legend: "Der Funk",
      connect: "Meshtastic®-Knoten verbinden",
      disconnect: "Knoten trennen",
      connecting: "verbinde…",
      connected: (region) => `Knoten verbunden · ${region}`,
      fake: "Fake-Mesh (dieser Browser)",
      fakeOn: "Fake-Mesh · zwei Tabs reden miteinander",
      none: "kein Knoten verbunden",
      lost: "Knoten weg — zum Neuverbinden neu laden",
      reconnecting: "Knoten weg — verbinde neu…",
      unset: "der Knoten hat keine Region gesetzt — er sendet nicht",
      channel: "Kanal",
      airUtil: (pct) => `von diesem Knoten belegte Luft: ${pct}%`,
      awake: "Bildschirm wachhalten",
      awakeWhy:
        "Web Bluetooth pausiert, wenn der Bildschirm sperrt: Der Knoten bleibt verbunden, die Seite kann nicht mehr mit ihm reden. In der Tasche merkt das niemand.",
    },

    errors: {
      gaveUp: "der Knoten kam nicht zurück — zum Verbinden neu laden",
    },

    where: {
      legend: "Wo das hier ist",
      node: "vom Knoten",
      browser: "vom Browser",
      none: "noch keine Position",
      waiting: "die anderen werden trotzdem gezeichnet, nur dieses Gerät steht nicht auf der Karte",
      accuracy: (metres) => `±${metres} m`,
      age: (seconds) => (seconds < 2 ? "gerade eben" : `vor ${seconds} s`),
      stale: "veraltet",
      held: (seconds) =>
        `Es ging nichts raus: Dieser Fix ist ${seconds} s alt, und ein Beacon trägt keine Zeit — die anderen würden ihn als aktuell einzeichnen. Das Telefon meldet eine Position, wenn sie sich ändert, Stillstehen ist also still.`,
      ask: "Nach dem Standort fragen",
      trouble: {
        searching:
          "Sucht noch — bisher nichts. Ohne SIM hat der Empfänger keine Hilfsdaten und liest den Almanach von den Satelliten selbst; das dauert Minuten und braucht freien Himmel.",
        denied:
          "Dieser Seite ist der Standort gesperrt. Ein Knopf hebt das nicht auf — in den Browser-Einstellungen für diese Seite erlauben.",
        unavailable:
          "Der Empfänger hat nichts geliefert. Drinnen ist das die normale Antwort: ohne Netzwerk-Ortung bleiben nur Satelliten.",
        unsupported:
          "Dieser Browser bietet hier keinen Standort an. Eine Seite über einfaches HTTP darf gar nicht fragen — das geht nur über HTTPS.",
      },
    },

    people: {
      legend: "Wer da draußen ist",
      empty: "Noch niemand gehört. Eine Zeile erscheint, wenn ein Gerät sagt, wo es ist.",
      summary: ({ heard, shown, moving }) =>
        `${heard} ${plural(heard, "Gerät", "Geräte")} gehört · ${shown} gezeichnet · ${moving} in Bewegung`,
      you: "dieses Gerät",
      namePlaceholder: "ein Name für dieses Gerät",
      nameWhy: "Namen bleiben auf diesem Telefon und gehen nie über den Funk.",
      lastHeard: (text) => `gehört ${text}`,
      heading: (point, metres) => `${point}, ${metres}`,
      show: "Zeichnen",
      forget: "Vergessen",
      confirmForget: "Dieses Gerät und seine Spur vergessen?",
    },

    map: {
      legend: "Der Weg",
      empty: "Noch nichts zu zeichnen: eine Spur erscheint, wenn ein Gerät sagt, wo es ist.",
      station: "dieses Gerät",
      here: "dieses Gerät",
      recentre: "Alle ins Bild",
      offline:
        "Keine Kartenkacheln — hier ist kein Internet. Spuren, Entfernungen und Richtungen werden aus Zahlen gezeichnet, die dieses Gerät schon hat.",
      note: "Jedes Gerät hat seine Farbe; das hellere Ende einer Spur ist das neuere. Kartendaten © OpenStreetMap-Mitwirkende.",
    },

    checkIn: {
      legend: "Wie es mir geht",
      why: "Wird sofort gesagt, nicht erst beim nächsten Takt — genau dafür drückt man es. Nochmal drücken heißt wieder alles gut.",
      states: { ok: "Alles gut", wait: "Bleibe hier", come: "Kommt zu mir", help: "Hilfe" },
      mine: (state) => `Dieses Gerät sagt: ${state}`,
    },

    compass: {
      legend: "Wohin",
      none: "Jemanden in der Liste auswählen, dann steht hier, wie weit und in welche Richtung.",
      noPlace: "Dieses Gerät hat noch keine Position, kann also keine Richtung ausrechnen.",
      line: (name, point, metres) => `${name} · ${point} · ${metres}`,
      age: (text) => `diese Position ist ${text}`,
      stale: "Alt genug, um inzwischen woanders zu sein.",
      follow: "Folgen",
      stop: "Nicht mehr folgen",
    },

    hunt: {
      legend: "Fuchsjagd",
      why: "Ein Gerät ist der Fuchs und sagt selten, wo es ist; alle anderen suchen. Der Kompass oben zeigt während einer Jagd auf den Fuchs.",
      iAmFox: "Ich bin der Fuchs",
      foxHeard: (name) => `der Fuchs ist ${name}`,
      noFox: "Noch kein Fuchs gehört.",
      slower: "Ein Fuchs mit langem Takt ist das Spiel; ein Fuchs im Minutentakt ist ein Spaziergang mit Zusatzschritten.",
    },

    show: {
      legend: "Was diese Seite zeigt",
      why: "Ein Spaziergang und eine Werkbank wollen verschiedene Bildschirme. Bleibt auf diesem Gerät.",
      map: "Die Karte",
      trails: "Spuren, nicht nur der aktuelle Ort",
      people: "Wer da draußen ist",
      compass: "Wohin",
      checkIn: "Wie es mir geht",
      hunt: "Fuchsjagd",
    },

    log: {
      legend: "Feldlog",
      sent: (bytes) => `→ meine Position (${bytes} B)`,
      heard: (from, bytes) => `← ${from} (${bytes} B)`,
      ignored: (why) => `· ignoriert: ${why}`,
      nodeStatus: (name) => `Knoten ${name}`,
      region: (name) => `Knotenregion ${name}`,
      nodeChannel: (index, name, print) => `Kanal ${index} »${name}« ⌗${print}`,
      autoChannel: (index, name, print) => `→ Kanal ${index} »${name}« ⌗${print} (bevorzugt)`,
      handChannel: (index, name, print) => `→ Kanal ${index} »${name}« ⌗${print} (gewählt)`,
      linkDropped: (n) => `Verbindung weg — Reparatur ${n}`,
      reconnected: "Verbindung wieder da",
      gaveUp: "✗ der Knoten kam nicht zurück",
      wakeOn: "Bildschirm wird wachgehalten",
      wakeOff: "Bildschirm darf wieder schlafen",
      wakeRefused: (why) => `die Bildschirmsperre wurde verweigert: ${why}`,
      position: (source, text, accuracy) =>
        `Position (${source}) ${text}${Number.isFinite(accuracy) ? ` ±${Math.round(accuracy)} m` : ""}`,
      heldBack: (seconds) => `nichts gesagt — der Fix ist ${seconds} s alt`,
      noFix: (kind, message) => `! keine Position (${kind})${message ? `: ${message}` : ""}`,
      broadcastOn: "sendet ab jetzt die eigene Position",
      broadcastOff: "sendet die eigene Position nicht mehr",
      checkIn: (state) => `· ich bin ${state}`,
      foxOn: "· ich bin der Fuchs",
      foxOff: "· nicht mehr der Fuchs",
      windowError: (type, message) => `! Fenster ${type}: ${message}`,
      gattQueueOn: "immer nur eine Bluetooth-Operation gleichzeitig",
      error: (message) => `Fehler: ${message}`,
      disconnected: "Knoten getrennt",
    },

    footer: (info) => `funkpost ${info.version} · ${info.commit} · gebaut ${info.builtAt}`,
  },
};
