// -----------------------------------------------------------------------------
// Keys shared with the manifest, timings and limits.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 25105;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  BUTTON: 'button',
};

/** The actions of the `button` trigger (a press of a keypad, remote or paddle). */
export const BUTTON_ACTIONS = ['on', 'off', 'fast_on', 'fast_off', 'dim_start', 'dim_stop'];

export const TIMINGS = {
  /** The buffer of the hub is read this often (pyinsteon: 500 ms). */
  poll: 500,
  /** First read after a message was sent (the device answers within ~0.5 s). */
  firstPoll: 300,
  /** Bound of one HTTP request to the hub. */
  httpTimeout: 5_000,
  /** Default wait for the answer of a background request. */
  answer: 3_000,
  /** A command is sent within this time of the request, or not at all. */
  sendBy: 3_500,
  /** ... and confirmed by the device within this one (Gladys waits 5 s). */
  answerBy: 4_500,
  /** Read back of a command left without confirmation. */
  readBack: 2_000,
  /** Reconnections: 10 s, 30 s, 1 min, 2 min, then 5 min. */
  retries: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** The identity of the hub (its Insteon address) is read again this often. */
  identity: 10 * 60_000,
  /** The database of the hub is read again on "Scan" at most this often. */
  scanGap: 10 * 60_000,
  /** An ID request to a device that never answered, at most this often. */
  idRetry: 10 * 60_000,
  /** A status read triggered by a change seen on the network, at most this often per device. */
  eventRead: 10_000,
  /** Time stamps in /data are written at most this often. */
  persistGap: 60_000,
  /** Unchanged states are sent again this often (offset per feature). */
  stateHeartbeat: 30 * 60_000,
  heartbeatSpread: 5 * 60_000,
  /** Wait of "Test the connection". */
  testWait: 20_000,
  /** Broadcasts repeated by the network: pyinsteon's MIN_DUP and MAX_DUP. */
  minDuplicate: 700,
  maxDuplicate: 2_000,
};

export const LIMITS = {
  statesPerMinute: 300,
  eventsPerMinute: 120,
  failuresInARow: 3,
  urgentQueue: 30,
  backgroundQueue: 600,
  /** Records read from the database of the hub, devices kept. */
  maxRecords: 2_000,
  maxDevices: 400,
  /** Entries of the "declared safe" list. */
  maxSafe: 500,
  /** Status reads, minutes. */
  minInterval: 2,
  maxInterval: 60,
};
