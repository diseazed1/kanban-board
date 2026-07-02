import argon2 from './node_modules/argon2/index.js';
const hash = await argon2.hash('KanbanBoard_2026!', {type: 0, memoryCost: 65536, timeCost: 3, parallelism: 2});
console.log(hash);
