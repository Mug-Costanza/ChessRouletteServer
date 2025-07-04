const { Chess } = require('chess.js');
const games = new Map();

const generateUniqueGameID = () => {
    let id;
    do {
        id = Math.random().toString().slice(2, 8);
    } while (games.has(id));
    return id;
};

const addPlayer = ({ name, playerID, gameID }) => {
    if (!games.has(gameID)) {
        return { error: 'Game not found' };
    }

    const currentGame = games.get(gameID);

    const alreadyInGame = currentGame.players.some(p => p.playerID === playerID);
    if (alreadyInGame) {
        return { error: 'Player already in game' };
    }

    if (currentGame.players.length >= 2) {
        return { error: 'Game is full' };
    }

    const color = currentGame.players.length === 0 ? 'w' : 'b';
    const newPlayer = { name, playerID, color };
    currentGame.players.push(newPlayer);

    const opponent = currentGame.players.find(p => p.playerID !== playerID);

    console.log(`[addPlayer] Added ${name} (${playerID}) as ${color} to game ${gameID}. Current players:`, currentGame.players);

    return { player: newPlayer, opponent };
};

const removePlayer = (playerID) => {
    for (const [gameID, currentGame] of games.entries()) {
        const index = currentGame.players.findIndex(p => p.playerID === playerID);
        if (index !== -1) {
            const [removed] = currentGame.players.splice(index, 1);

            // If game is now empty, delete it from the map
            if (currentGame.players.length === 0) {
                games.delete(gameID);
            }

            return { ...removed, gameID };
        }
    }
    return null;
};

const game = (gameID) => {
    return games.get(gameID);
};

module.exports = {
    addPlayer,
    removePlayer,
    game,
    games,
    generateUniqueGameID,
};
