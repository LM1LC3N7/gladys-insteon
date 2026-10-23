// -----------------------------------------------------------------------------
// French and English texts: statuses, command errors, device and feature names.
// An entry is { en, fr }, each a string or a function of the arguments.
// -----------------------------------------------------------------------------

/** entry, language -> the text (a function stays a function). */
export const word = (entry, language) => entry[language] ?? entry.en;

/** entry + arguments -> { en, fr } strings. */
export function fill(entry, ...args) {
  const out = {};
  for (const lang of ['en', 'fr']) {
    const text = entry[lang];
    out[lang] = typeof text === 'function' ? text(...args) : text;
  }
  return out;
}

const plural = (n, one, many) => (n === 1 ? one : many);

export const T = {
  noConfig: {
    en: 'Enter the address of the hub, its user name and its password (printed under the hub).',
    fr: "Saisissez l'adresse du hub, son nom d'utilisateur et son mot de passe (imprimés sous le hub).",
  },
  badHubAddress: {
    en: 'The "Insteon address of the hub" is not an address (6 hexadecimal digits, e.g. 1A.2B.3C).',
    fr: "L'« adresse Insteon du hub » n'est pas une adresse (6 chiffres hexadécimaux, par ex. 1A.2B.3C).",
  },
  connecting: { en: 'Connecting to the hub…', fr: 'Connexion au hub…' },
  connected: {
    en: (devices, extra) =>
      `Connected to the hub: ${devices} ${plural(devices, 'device', 'devices')}.${extra}`,
    fr: (devices, extra) =>
      `Connecté au hub : ${devices} ${plural(devices, 'appareil', 'appareils')}.${extra}`,
  },
  scanning: {
    en: (step) => `Connected to the hub, reading its devices (${step})…`,
    fr: (step) => `Connecté au hub, lecture de ses appareils (${step})…`,
  },
  unknownTypes: {
    en: (list) => ` Type not known yet (battery devices: press their set button once): ${list}.`,
    fr: (list) =>
      ` Type pas encore connu (appareils sur pile : appuyez une fois sur leur bouton set) : ${list}.`,
  },
  unsupported: {
    en: (list) => ` Not supported yet: ${list}.`,
    fr: (list) => ` Pas encore pris en charge : ${list}.`,
  },
  safeErrors: {
    en: (list) => ` Not understood in "Devices declared safe": ${list}.`,
    fr: (list) => ` Non compris dans « Appareils déclarés sûrs » : ${list}.`,
  },
  unreachable: {
    en: (reason, seconds) => `Hub unreachable (${reason}); next try in ${seconds} s.`,
    fr: (reason, seconds) => `Hub injoignable (${reason}) ; nouvel essai dans ${seconds} s.`,
  },
  refused: {
    en: 'The hub refused the user name or the password: no new try. Correct them (they are printed under the hub), or click "Test the connection" once the hub accepts them.',
    fr: "Le hub a refusé le nom d'utilisateur ou le mot de passe : aucun nouvel essai. Corrigez-les (ils sont imprimés sous le hub), ou cliquez sur « Tester la connexion » quand le hub les accepte.",
  },
  otherHub: {
    en: (seen, expected) =>
      `Another hub answers at this address (Insteon address ${seen}, expected ${expected}): nothing is read nor sent. If you replaced the hub, enter ${seen} in "Insteon address of the hub".`,
    fr: (seen, expected) =>
      `Un autre hub répond à cette adresse (adresse Insteon ${seen}, attendue ${expected}) : rien n'est lu ni envoyé. Si vous avez remplacé le hub, saisissez ${seen} dans « Adresse Insteon du hub ».`,
  },
  stillConnecting: {
    en: 'The hub has not answered yet: try again in a moment.',
    fr: "Le hub n'a pas encore répondu : réessayez dans un instant.",
  },
  testOk: {
    en: (hub, devices) => `The hub answers (Insteon address ${hub}); ${devices} device(s) known.`,
    fr: (hub, devices) =>
      `Le hub répond (adresse Insteon ${hub}) ; ${devices} appareil(s) connu(s).`,
  },
  // Command errors.
  offline: {
    en: 'The hub is not connected: nothing was sent.',
    fr: "Le hub n'est pas connecté : rien n'a été envoyé.",
  },
  tooLate: {
    en: 'The hub was too slow to take the command in time: nothing was sent.',
    fr: "Le hub a été trop lent pour prendre la commande à temps : rien n'a été envoyé.",
  },
  queueFull: {
    en: 'Too many commands waiting: nothing was sent.',
    fr: "Trop de commandes en attente : rien n'a été envoyé.",
  },
  notSafe: {
    en: 'This device is not declared safe in the configuration: nothing was sent.',
    fr: "Cet appareil n'est pas déclaré sûr dans la configuration : rien n'a été envoyé.",
  },
  buttonsOff: {
    en: 'The "Turn on" and "Turn off" buttons are disabled in the configuration: nothing was sent.',
    fr: "Les boutons « Allumer » et « Éteindre » sont désactivés dans la configuration : rien n'a été envoyé.",
  },
  hubUnknown: {
    en: 'The identity of the hub is not known yet: nothing was sent.',
    fr: "L'identité du hub n'est pas encore connue : rien n'a été envoyé.",
  },
  otherHubCommand: {
    en: 'Another hub answers at this address: nothing was sent.',
    fr: "Un autre hub répond à cette adresse : rien n'a été envoyé.",
  },
  unknownDevice: {
    en: 'Unknown Insteon device: nothing was sent.',
    fr: "Appareil Insteon inconnu : rien n'a été envoyé.",
  },
  readOnly: {
    en: 'This feature is read only: nothing was sent.',
    fr: "Cette fonctionnalité est en lecture seule : rien n'a été envoyé.",
  },
  badValue: {
    en: (value) => `Invalid value ${value}: nothing was sent.`,
    fr: (value) => `Valeur invalide ${value} : rien n'a été envoyé.`,
  },
  unconfirmed: {
    en: (what) => `${what}: sent, without confirmation from the device.`,
    fr: (what) => `${what} : envoyé, sans confirmation de l'appareil.`,
  },
  deviceRefused: {
    en: (what) => `${what}: the device answered that it did not apply it.`,
    fr: (what) => `${what} : l'appareil a répondu qu'il ne l'a pas appliqué.`,
  },
};

export const COMMAND_NAMES = {
  level: {
    en: (address, level) => (level === 0 ? `${address} off` : `${address} on at ${level} %`),
    fr: (address, level) => (level === 0 ? `${address} éteint` : `${address} allumé à ${level} %`),
  },
  on: { en: (address) => `${address} on`, fr: (address) => `${address} allumé` },
};

export const FEATURE_NAMES = {
  binary: { en: 'Power', fr: 'Alimentation' },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  switch: { en: 'Switch', fr: 'Interrupteur' },
  light: { en: 'Light', fr: 'Lumière' },
  state: { en: 'State', fr: 'État' },
  level: { en: 'Level (%)', fr: 'Niveau (%)' },
  turn_on: { en: 'Turn on', fr: 'Allumer' },
  turn_off: { en: 'Turn off', fr: 'Éteindre' },
  input: { en: 'Sensor input', fr: 'Entrée capteur' },
  relay: { en: 'Relay', fr: 'Relais' },
  motion: { en: 'Motion', fr: 'Mouvement' },
  opening: { en: 'Opening', fr: 'Ouverture' },
  leak: { en: 'Leak', fr: 'Fuite' },
  smoke: { en: 'Smoke', fr: 'Fumée' },
  co: { en: 'Carbon monoxide', fr: 'Monoxyde de carbone' },
  battery_low: { en: 'Low battery', fr: 'Pile faible' },
};
