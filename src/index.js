const http = require('http');
const socketio = require('socket.io');
const express = require('express');
const { addPlayer, game, removePlayer, games } = require('./game');
const { Chess } = require('chess.js');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => res.send({ status: 'healthy' }));

const server = http.createServer(app);
const PORT = 3001;

const io = socketio(server, {
    cors: {
        origin: 'http://localhost:3000',
        methods: ['GET', 'POST'],
    },
});

function getBaseTime(timeControl) {
    if (timeControl === 'bullet') return 60;
    if (timeControl === 'blitz') return 180;
    return 600; // rapid default
}

function stopGameInterval(currentGame) {
    if (currentGame && currentGame.interval) {
        clearInterval(currentGame.interval);
        currentGame.interval = null;
    }
}

function cleanupGame(gameID) {
    const currentGame = games.get(gameID);
    if (!currentGame) return;
    stopGameInterval(currentGame);
    games.delete(gameID);
    console.log(`[cleanup] Game ${gameID} cleaned up from memory.`);
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('create', ({ gameID, timeControl }, callback) => {
        if (games.has(gameID)) {
            return callback({ error: 'Game ID already exists' });
        }
        const baseTime = getBaseTime(timeControl);
        const newGame = {
            players: [],
            chessInstance: new Chess(),
            turn: 'w',
            timeControl,
            private: true,
            playerClocks: { w: baseTime, b: baseTime },
            moveClock: 60,
            lastUpdate: Date.now(),
            interval: null,
        };
        games.set(gameID, newGame);
        console.log(`${gameID} is looking for a match...`);
        callback({ success: true });
    });

    socket.on('matchmake', ({ name, timeControl }, callback) => {
        for (const [gameID, currentGame] of games.entries()) {
            if (
                currentGame.players.length === 1 &&
                currentGame.timeControl === timeControl &&
                !currentGame.private
            ) {
                const { error, player } = addPlayer({
                    name,
                    playerID: socket.id,
                    gameID,
                });

                if (error) return callback({ error });

                socket.join(gameID);
                return callback({ gameID, name, color: player.color });
            }
        }
        const baseTime = getBaseTime(timeControl);
        const gameID = Math.random().toString().slice(2, 8);
        const newGame = {
            players: [],
            chessInstance: new Chess(),
            turn: 'w',
            timeControl,
            private: false,
            playerClocks: { w: baseTime, b: baseTime },
            moveClock: 60,
            lastUpdate: Date.now(),
            interval: null,
        };

        games.set(gameID, newGame);
        console.log(`${gameID} created for quick join...`);

        const { error, player } = addPlayer({
            name,
            playerID: socket.id,
            gameID,
        });

        if (error) return callback({ error });

        socket.join(gameID);
        return callback({ gameID, name, color: player.color });
    });

    socket.on('join', ({ name, gameID, timeControl }, callback) => {
        console.log(`Socket ${socket.id} attempting to join game ${gameID}`);

        const currentGame = game(gameID);
        if (!currentGame) {
            return callback({ error: 'Game not found' });
        }

        let player = currentGame.players.find(p => p.playerID === socket.id);
        let opponent = currentGame.players.find(p => p.playerID !== socket.id);

        if (!player) {
            const result = addPlayer({ name, playerID: socket.id, gameID });
            if (result.error) {
                console.error('Join Error:', result.error);
                return callback({ error: result.error });
            }
            player = result.player;
            opponent = result.opponent;
        }

        socket.join(gameID);
        callback({ color: player.color, timeControl: currentGame.timeControl });

        io.to(gameID).emit('lobbyUpdate', {
            players: currentGame.players.map((p) => p.name),
            gameID,
        });

        socket.emit('welcome', {
            message: `Hello ${player.name}, welcome to the game.`,
            opponent,
        });

        socket.broadcast.to(gameID).emit('opponentJoin', {
            message: `${player.name} has joined.`,
            opponent: player,
        });

        if (currentGame.players.length >= 2) {
            console.log(`[join] Players in game ${gameID}:`, currentGame.players);
            const white = currentGame.players.find((p) => p.color === 'w');
            const black = currentGame.players.find((p) => p.color === 'b');

            if (white && black) {
                io.to(gameID).emit('message', {
                    message: `Game start! White (${white.name}) goes first.`,
                });

                setTimeout(() => {
                    io.to(gameID).emit('gameStart');
                    io.to(gameID).emit('clockUpdate', {
                        playerClocks: currentGame.playerClocks,
                        moveClock: currentGame.moveClock,
                        turn: currentGame.turn,
                    });
                }, 100);

                if (!currentGame.interval) {
                    currentGame.lastUpdate = Date.now();
                    currentGame.interval = setInterval(() => {
                        const now = Date.now();
                        const delta = Math.floor((now - currentGame.lastUpdate) / 1000);
                        if (delta > 0) {
                            currentGame.lastUpdate = now;
                            const t = currentGame.turn;
                            currentGame.playerClocks[t] = Math.max(0, currentGame.playerClocks[t] - delta);
                            currentGame.moveClock = Math.max(0, currentGame.moveClock - delta);

                            io.to(gameID).emit('clockUpdate', {
                                playerClocks: currentGame.playerClocks,
                                moveClock: currentGame.moveClock,
                                turn: currentGame.turn,
                            });

                            if (currentGame.playerClocks[t] <= 0 || currentGame.moveClock <= 0) {
                                io.to(gameID).emit('gameOver', {
                                    status: 'timeout',
                                    player: t,
                                });
                                cleanupGame(gameID);
                            }
                        }
                    }, 1000);
                }
            }
        }
    });

    socket.on('leave', ({ gameID, playerID }) => {
        const currentGame = game(gameID);
        if (!currentGame) return;

        const playerIndex = currentGame.players.findIndex(p => p.playerID === playerID);
        if (playerIndex !== -1) {
            const [removedPlayer] = currentGame.players.splice(playerIndex, 1);

            io.to(gameID).emit('message', {
                message: `${removedPlayer.name} has left the game.`,
            });

            io.to(gameID).emit('lobbyUpdate', {
                players: currentGame.players.map((p) => p.name),
                gameID,
            });

            console.log(`${removedPlayer.name} has left the game ${gameID}`);
        }
    });

    socket.on('move', (data, callback) => {
        const { gameID, from, to, rouletteRoll } = data;
        const currentGame = game(gameID);
        if (!currentGame) return callback?.({ error: 'Game not found' });

        const player = currentGame.players.find((p) => p.playerID === socket.id);
        if (!player) return callback?.({ error: 'Player not part of this game' });

        if (player.color !== currentGame.turn) {
            return callback?.({ error: 'Not your turn' });
        }

        let wasRouletteKill = false;

        const now = Date.now();
        const delta = Math.floor((now - currentGame.lastUpdate) / 1000);
        currentGame.lastUpdate = now;
        currentGame.playerClocks[currentGame.turn] = Math.max(0, currentGame.playerClocks[currentGame.turn] - delta);
        currentGame.moveClock = 60;

        const chess = currentGame.chessInstance;
        const targetPiece = chess.get(to);
        if (targetPiece?.type === 'k') {
            return callback?.({ error: 'Illegal move: Cannot capture king' });
        }

        const move = chess.move({ from, to, promotion: 'q' });
        if (!move) return callback?.({ error: 'Invalid move' });

        if (move.piece !== 'k' && rouletteRoll === 1) {
            chess.remove(to);
            wasRouletteKill = true;
        }

        currentGame.turn = currentGame.turn === 'w' ? 'b' : 'w';

        io.to(gameID).emit('opponentMove', {
            ...data,
            fen: chess.fen(),
            wasRouletteKill,
            captured: wasRouletteKill && targetPiece
                ? { type: targetPiece.type, color: targetPiece.color }
                : null
        });

        io.to(gameID).emit('turnUpdate', {
            turn: currentGame.turn,
            timestamp: Date.now()
        });

        io.to(gameID).emit('clockUpdate', {
            playerClocks: currentGame.playerClocks,
            moveClock: currentGame.moveClock,
            turn: currentGame.turn,
        });

        let status = null;
        if (chess.isCheckmate()) status = "checkmate";
        else if (chess.isStalemate()) status = "stalemate";
        else if (chess.isDraw()) status = "draw";
        else if (chess.isInsufficientMaterial()) status = "insufficient-material";
        else if (chess.isThreefoldRepetition()) status = "threefold-repetition";

        if (!status && chess.isGameOver()) {
            status = "draw";
        }

        if (status) {
            io.to(gameID).emit("gameOver", {
                status,
                player: chess.turn()
            });
            cleanupGame(gameID);
        }
    });

    socket.on('resign', ({ gameID, player }) => {
        const currentGame = game(gameID);
        if (!currentGame) return;

        io.to(gameID).emit('gameOver', {
            status: 'resigned',
            player,
        });
        cleanupGame(gameID);
    });

    socket.on('disconnect', () => {
        const player = removePlayer(socket.id);
        if (player) {
            io.to(player.gameID).emit('message', {
                message: `${player.name} has left the game.`,
            });

            socket.broadcast.to(player.gameID).emit('opponentLeft');

            io.to(player.gameID).emit('lobbyUpdate', {
                players: game(player.gameID)?.players.map((p) => p.name) || [],
                gameID: player.gameID,
            });

            console.log(`${player.name} has left the game ${player.gameID}`);
            cleanupGame(player.gameID);
        }
    });
});

server.listen(PORT, () => console.log('Server running on localhost: ' + PORT));
