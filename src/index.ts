import { Context, Schema, Session, Model } from 'koishi' // 引入 Model 类型
import dayjs from 'dayjs'

export const name = 'deerpipe-qbot'

export interface Config {
  specialDates: string[]
  isDevelopment: boolean
}

export const Config: Schema<Config> = Schema.object({
  specialDates: Schema.array(Schema.string()).default([
    '07-08', '07-21', '09-01',
  ]),
  isDevelopment: Schema.boolean().default(false),
})

declare module 'koishi' {
  interface Tables {
    users: UserData
  }
}

export interface UserData {
  userId: string;
  username: string;
  lastCheckIn: string | null;
  points: number;
  lv: number;
  experience: number;
  streak: number;
}

interface LobbyPlayer {
  bet: number;
  session: Session;
  timeoutId: NodeJS.Timeout;
}

interface PendingGame {
  player1Id: string;
  player2Id: string;
  player1Session: Session;
  player2Session: Session;
  player1Bet: number;
  player2Bet: number;
  winnerId: string;
}

interface ActiveGame extends PendingGame {
  logCount: number;
  intervalId: NodeJS.Timeout;
}

// 战况播报说是
export function apply(ctx: Context, config: Config) {
  // 定义 'users' 表的 schema。Koishi 会根据这个定义自动创建或更新表结构。
  ctx.model.extend('users', {
    userId: 'string', // 主键
    username: 'string',
    lastCheckIn: 'string',
    points: 'integer',
    lv: 'integer',
    experience: 'integer',
    streak: 'integer',
  }, {
    primary: 'userId',
  })

  // 内存中的 Map 可以移除，因为数据将从数据库中读取和写入
  // const userData: Map<string, UserData> = new Map();

  const matchingLobby: Map<string, LobbyPlayer> = new Map();
  const pendingGames: Map<string, PendingGame> = new Map();
  const activeGames: Map<string, ActiveGame> = new Map();

  const DEPOSIT = 5;
  const LOBBY_TIMEOUT_MS = 60 * 1000;
  const BATTLE_LOG_INTERVAL_MS = 2 * 1000;
  const BATTLE_LOG_COUNT = 5;
  const RANK_TOP_N = 10; // 积分榜单显示前 N 名

  const WINNER_PHRASES = ['占据上风', '猛烈攻击', '步步紧逼', '势如破竹', '占据优势', '压制对手'];
  const LOSER_PHRASES = ['节节败退', '苦苦支撑', '勉力抵挡', '露出破绽', '处于劣势', '险象环生'];

  if (config.isDevelopment) {
    // 开发模式下生成随机用户，并将其写入数据库
    const randomUserId = generateRandomUserId();
    const randomUserData: UserData = { ...generateRandomUserData(), userId: randomUserId }; // 确保包含 userId
    ctx.database.create('users', randomUserData)
      .then(() => console.log(`开发模式：已生成随机用户 ${randomUserId}，等级 ${randomUserData.lv}，用户名 ${randomUserData.username}`))
      .catch(err => console.error(`开发模式：生成随机用户失败: ${err}`));
  }

  // 打卡
  ctx.command('炉管打卡', '打卡并获得积分')
    .action(async ({ session }) => {
      const userId = session.userId;

      // 从数据库中获取用户数据。ctx.database.get 返回一个数组，即使只查询一个。
      let [user] = await ctx.database.get('users', { userId });

      if (!user) {
        // 如果用户数据不存在，初始化并插入数据
        user = await ctx.database.create('users', {
          userId,
          username: session.username,
          lastCheckIn: null,
          points: 0,
          lv: 0,
          experience: 0,
          streak: 0,
        });
      }

      const today = dayjs().format('MM-DD');
      const isSpecialDate = config.specialDates.includes(today);
      const isDevMode = config.isDevelopment;

      if (user.lastCheckIn === today) {
        return '今天你已经打过卡了！';
      }

      const pointsGained = Math.floor(Math.random() * 15) + 1;
      // 注意：这里 lvGain 的计算和 user.lv 的直接增加可能需要调整，
      // 通常等级是根据经验值计算得出的，而不是直接增加
      // 但为了保持原逻辑，这里先这样处理
      const lvGain = Math.floor(user.experience / 20); // 每20经验升一级
      user.lv += lvGain; // 增加等级
      user.experience += 20; // 增加经验

      user.streak += 1;
      if (user.streak % 7 === 0) {
        const weekNumber = user.streak / 7;
        session.send(`这是你打卡的第${weekNumber}周！`);
      }

      // 炉管失败逻辑：如果失败，不更新 lastCheckIn 和 points，用户可以再尝试
      if ((isDevMode && Math.random() < 0.5) || (isSpecialDate && Math.random() < 0.2)) {
        return '炉管失败！若今日是特殊日期，炉管失败时正常的！';
      }

      user.points += pointsGained;
      user.lastCheckIn = today;

      // 更新数据库中的用户数据
      await ctx.database.set('users', { userId }, {
        points: user.points,
        lv: user.lv,
        experience: user.experience,
        streak: user.streak,
        lastCheckIn: user.lastCheckIn
      });

      return `打卡成功！你获得了 ${pointsGained} 积分，当前积分：${user.points}，Lv：${user.lv}，经验：${user.experience}`;
    });

  // match匹配
  ctx.command('对对碰匹配', '参与牛子对对碰比赛，下注积分')
    .option('bet', '-下注 <points:number> 下注积分')
    .action(async ({ session, options }) => {
      const userId = session.userId;
      let [user] = await ctx.database.get('users', { userId });

      if (!user) {
        // 如果用户数据不存在，初始化并插入数据
        user = await ctx.database.create('users', {
          userId,
          username: session.username,
          lastCheckIn: null,
          points: 0,
          lv: 0,
          experience: 0,
          streak: 0
        });
      }

      const { bet } = options;

      if (typeof bet !== 'number' || bet <= 0) {
        return '请输入有效的下注积分 (大于0的数字)。例如：对对碰匹配 -下注 1';
      }

      const totalCost = bet + DEPOSIT;

      if (user.points < totalCost) {
        return `积分不足！你需要 ${totalCost} 积分（${bet}下注 + ${DEPOSIT}押金），你当前有 ${user.points} 积分。`;
      }

      // 检查是否已经在匹配或游戏中
      if (matchingLobby.has(userId) || pendingGames.has(userId) || activeGames.has(userId) || Array.from(pendingGames.values()).some(g => g.player2Id === userId) || Array.from(activeGames.values()).some(g => g.player2Id === userId)) {
        return '你已经在匹配或游戏中了，请勿重复操作。';
      }

      // 扣除积分和押金
      await ctx.database.set('users', { userId }, { points: user.points - totalCost });
      user.points -= totalCost; // 更新内存中的 user 对象以便后续使用

      const [opponentId, opponentLobbyData] = Array.from(matchingLobby.entries())[0] || [];

      if (opponentId && opponentLobbyData) {
        const [opponent] = await ctx.database.get('users', { userId: opponentId });
        if (!opponent) {
          matchingLobby.delete(opponentId);
          // 如果对手数据异常，退还当前玩家积分
          await ctx.database.set('users', { userId }, { points: user.points + totalCost });
          return '匹配失败：对手数据异常，已退还你的积分。';
        }

        clearTimeout(opponentLobbyData.timeoutId);
        matchingLobby.delete(opponentId);

        const [player1Data] = await ctx.database.get('users', { userId: opponentId })!;
        const [player2Data] = await ctx.database.get('users', { userId })!;

        const lvDifference = player1Data.lv - player2Data.lv;
        const player1WinChance = 0.5 + (lvDifference * 0.05);

        const winnerId = Math.random() < player1WinChance ? opponentId : userId;

        const game: PendingGame = {
          player1Id: opponentId,
          player2Id: userId,
          player1Session: opponentLobbyData.session,
          player2Session: session,
          player1Bet: opponentLobbyData.bet,
          player2Bet: bet,
          winnerId: winnerId,
        };
        pendingGames.set(opponentId, game);

        opponentLobbyData.session.send(`匹配成功！你将与 ${session.username} 对战。请在${LOBBY_TIMEOUT_MS / 1000}秒内输入 "start" 命令开始游戏。`);
        session.send(`匹配成功！你将与 ${opponentLobbyData.session.username} 对战。等待对方输入 "start" 命令开始游戏。`);

        return '匹配成功，等待对方开始游戏。';

      } else {
        const timeoutId = setTimeout(async () => {
          if (matchingLobby.has(userId)) {
            matchingLobby.delete(userId);
            // 超时未匹配到对手，退还积分
            await ctx.database.set('users', { userId }, { points: user.points + totalCost });
            await session.send(`60秒内未找到对手，你已退出匹配大厅。已退还 ${totalCost} 积分。当前积分：${user.points + totalCost}`);
          }
        }, LOBBY_TIMEOUT_MS);

        matchingLobby.set(userId, { bet: bet, session: session, timeoutId: timeoutId });
        return `你已进入牛子对对碰匹配大厅，等待其他玩家加入（${LOBBY_TIMEOUT_MS}秒内）。已扣除 ${bet} 积分和 ${DEPOSIT} 押金。当前积分：${user.points}`;
      }
    });

  ctx.command('start', '开始牛子对对碰比赛')
    .action(async ({ session }) => {
      const userId = session.userId;

      const game = pendingGames.get(userId);

      if (!game || game.player1Id !== userId) {
        return '你当前没有等待开始的牛子对对碰比赛，或者你不是发起者。';
      }

      pendingGames.delete(userId);
      const activeGame: ActiveGame = {
        ...game,
        logCount: 0,
        intervalId: setTimeout(() => {}, 0) // 占位符，将被 setInterval 替换
      };
      activeGames.set(userId, activeGame);

      await game.player1Session.send('牛子对对碰比赛开始！');
      await game.player2Session.send('牛子对对碰比赛开始！');

      // 立即发送第一条战报
      await sendBattleLog(activeGame);
      activeGame.intervalId = setInterval(() => sendBattleLog(activeGame), BATTLE_LOG_INTERVAL_MS);

      return '游戏已开始，战况播报中...';
    });

  // 查询积分命令
  ctx.command('query', '查询自己的积分和等级信息')
    .action(async ({ session }) => {
      const userId = session.userId;
      const [user] = await ctx.database.get('users', { userId }); // 获取用户数据

      if (!user) {
        return '你还没有任何数据，请先打卡或参与游戏。';
      }

      return `你的当前信息：
        用户名：${user.username}
        积分：${user.points}
        等级：Lv.${user.lv}
        经验：${user.experience}
        连续打卡：${user.streak}天`;
    });

  // 积分榜单命令
  ctx.command('rank', '查询积分排行榜')
    .action(async ({ session }) => {
      // 从数据库获取所有用户，并按积分降序排序
      // 修改前
      const allUsers = await ctx.database.select('users').orderBy('points', 'desc').execute();

      if (allUsers.length === 0) {
        return '目前还没有用户数据，榜单为空。';
      }

      let rankMessage = '✨ 积分排行榜 ✨\n';
      rankMessage += '--------------------\n';

      // 显示前 N 名
      for (let i = 0; i < Math.min(RANK_TOP_N, allUsers.length); i++) {
        const user = allUsers[i];
        rankMessage += `${i + 1}. ${user.username} (Lv.${user.lv}) - ${user.points} 积分\n`;
      }

      // 查找当前用户的排名
      const currentUserIndex = allUsers.findIndex((u) => u.userId === session.userId);

      if (currentUserIndex !== -1) {
        const currentUserData = allUsers[currentUserIndex];
        if (currentUserIndex >= RANK_TOP_N) {
          // 如果当前用户不在前 N 名，则单独显示其排名
          rankMessage += `--------------------\n`;
          rankMessage += `你的排名：${currentUserIndex + 1}. ${currentUserData.username} (Lv.${currentUserData.lv}) - ${currentUserData.points} 积分`;
        }
      } else {
        // 如果当前用户没有任何数据
        rankMessage += `--------------------\n`;
        rankMessage += `你还没有数据，无法显示排名。`;
      }

      return rankMessage;
    });


  // 发送战斗日志
  async function sendBattleLog(game: ActiveGame) {
    game.logCount++;

    const [winnerUserData] = await ctx.database.get('users', { userId: game.winnerId })!;
    const [loserUserData] = await ctx.database.get('users', { userId: game.winnerId === game.player1Id ? game.player2Id : game.player1Id })!;

    const winnerPhrase = WINNER_PHRASES[Math.floor(Math.random() * WINNER_PHRASES.length)];
    const loserPhrase = LOSER_PHRASES[Math.floor(Math.random() * LOSER_PHRASES.length)];

    const logMessage = `战况播报 (${game.logCount}/${BATTLE_LOG_COUNT})：${winnerUserData.lv}级 ${winnerUserData.username} ${winnerPhrase}，${loserUserData.lv}级 ${loserUserData.username} ${loserPhrase}！`;

    await game.player1Session.send(logMessage);
    await game.player2Session.send(logMessage);

    if (game.logCount >= BATTLE_LOG_COUNT) {
      clearInterval(game.intervalId);
      activeGames.delete(game.player1Id);

      // 再次获取最新的玩家数据，确保结算时积分正确
      const [player1] = await ctx.database.get('users', { userId: game.player1Id })!;
      const [player2] = await ctx.database.get('users', { userId: game.player2Id })!;

      let resultMessage1 = '';
      let resultMessage2 = '';

      if (game.winnerId === game.player1Id) {
        player1.points += game.player2Bet + DEPOSIT;
        resultMessage1 = `恭喜你，${player1.username}！你赢得了这场牛子对对碰！获得了对方的 ${game.player2Bet} 积分，并返还了 ${DEPOSIT} 押金。你当前积分：${player1.points}`;
        resultMessage2 = `很遗憾，${player2.username}，你输掉了这场牛子对对碰！失去了 ${game.player2Bet} 积分和 ${DEPOSIT} 押金。你当前积分：${player2.points}`;
      } else {
        player2.points += game.player1Bet + DEPOSIT;
        resultMessage1 = `很遗憾，${player1.username}，你输掉了这场牛子对对碰！失去了 ${game.player1Bet} 积分和 ${DEPOSIT} 押金。你当前积分：${player1.points}`;
        resultMessage2 = `恭喜你，${player2.username}！你赢得了这场牛子对对碰！获得了对方的 ${game.player1Bet} 积分，并返还了 ${DEPOSIT} 押金。你当前积分：${player2.points}`;
      }

      // 更新数据库中的积分
      await ctx.database.set('users', { userId: game.player1Id }, { points: player1.points });
      await ctx.database.set('users', { userId: game.player2Id }, { points: player2.points });

      await game.player1Session.send(resultMessage1);
      await game.player2Session.send(resultMessage2);
    }
  }

  // 生成随机用户ID
  function generateRandomUserId(): string {
    return `user_${Math.floor(Math.random() * 10000)}`;
  }

  // 生成随机用户数据（等级1-5）
  function generateRandomUserData(): Omit<UserData, 'userId'> { // 返回不包含 userId 的数据，因为 userId 会在创建时生成
    const lv = Math.floor(Math.random() * 5) + 1;
    return {
      username: `随机用户${Math.floor(Math.random() * 1000)}`,
      lastCheckIn: null,
      points: Math.floor(Math.random() * 100) + 10,
      lv: lv,
      experience: lv * 20,
      streak: Math.floor(Math.random() * 7),
    };
  }
}
