module.exports = {
  // SECURITY: put your NEW BotFather token here. Never publish it to GitHub.
  BOT_TOKEN: "8670250150:AAE2h4c91KY3_CNKRUFuFTnCpri1d2RofpY",

  ADMIN_UID: "7543779661",
  CHANNEL_ID: "-1004470478229",

  TIMEZONE: "Asia/Dhaka",
  MODE: "1m",
  POLL_MS: 2500,
  REQUEST_TIMEOUT_MS: 8000,

  DELETE_ON_LOSS: true,
  SUPER_WIN_STREAK: 2,

  // LOSS -> HOLD system
  LOSS_HOLD: {
    enabled: true,
    lossThreshold: 3,   // after this many consecutive losses...
    holdPeriods: 2      // skip this many upcoming prediction periods
  },

  PREMIUM: {
    enabled: true,
    userIds: []
  },

  SCHEDULE: {
    enabled: false,
    warningMinutes: 30,
    sessions: [
      { start: "20:00", end: "23:00" }
    ]
  },

  MESSAGE_TEMPLATE:
    "🎯 <b>PREDICTION</b>\\nPeriod: <code>{period}</code>\\nSide: <b>{side}</b>\\nNumbers: <b>{n1}</b> / <b>{n2}</b>\\nConfidence: <b>{confidence}%</b>\\nRule: <i>{rule}</i>",

  WIN_MESSAGE:
    "✅ <b>WIN</b> | {period}\\nResult: <b>{result}</b> ({predSide})\\n🔥 Streak: <b>{streak}</b>",

  JACKPOT_MESSAGE:
    "💎 <b>JACKPOT NUMBER</b> | {period}\\nExact: <b>{result}</b>\\n🔥 Streak: <b>{streak}</b>",

  SUPER_WIN_MESSAGE:
    "🚀 <b>SUPER WIN</b>\\n{period} | Result: <b>{result}</b>\\n🔥 Consecutive wins: <b>{streak}</b>",

  LOSS_MESSAGE:
    "❌ <b>LOSS</b> | {period}\\nResult: <b>{result}</b>\\nLoss streak: <b>{lossStreak}</b>",

  HOLD_MESSAGE:
    "🛡 <b>SAFETY HOLD</b>\\nAfter <b>{lossStreak}</b> consecutive losses, predictions are paused for <b>{holdPeriods}</b> periods.",

  SESSION_WARNING_MESSAGE:
    "⏰ <b>SESSION STARTING SOON</b>\\nStart: <b>{start}</b>\\nEnd: <b>{end}</b>\\nStarts in <b>{minutes} min</b>."
};
