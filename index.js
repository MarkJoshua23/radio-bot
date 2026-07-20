const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  StreamType,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

// Load configurations from .env
require('dotenv').config();

const token = process.env.DISCORD_TOKEN;
const streamUrl = process.env.STREAM_URL;

if (!token) {
  console.error('Error: DISCORD_TOKEN not set in environment');
  process.exit(1);
}

if (!streamUrl) {
  console.error('Error: STREAM_URL not set in environment');
  process.exit(1);
}

// Setup client with required voice and guilds intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the voice channel and play the radio stream'),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect from the voice channel')
].map(command => command.toJSON());

// State variables for shared streaming
const sharedPlayer = createAudioPlayer();
let sharedFfmpegProcess = null;
let sharedResource = null;
const activeConnections = new Map();
let restartTimeout = null;

// Global Player Event Listeners (registered once)
sharedPlayer.on('stateChange', (oldState, newState) => {
  console.log(`[Player StateChange] ${oldState.status} -> ${newState.status}`);
});

sharedPlayer.on('error', (error) => {
  console.error('Shared AudioPlayer error:', error);
  stopSharedStream();
  if (activeConnections.size > 0) {
    requestRestart(streamUrl);
  }
});

sharedPlayer.on(AudioPlayerStatus.Idle, () => {
  console.log('Shared AudioPlayer went idle.');
  stopSharedStream();
  if (activeConnections.size > 0) {
    requestRestart(streamUrl);
  }
});

// Helper to request a delayed restart of the stream
function requestRestart(url) {
  if (restartTimeout) {
    return; // A restart is already scheduled
  }
  console.log('Scheduling stream restart in 5 seconds to prevent CPU loops...');
  restartTimeout = setTimeout(() => {
    restartTimeout = null;
    if (activeConnections.size > 0) {
      startSharedStream(url);
    }
  }, 5000);
}

// Helper to start the shared stream
function startSharedStream(url) {
  if (sharedFfmpegProcess) {
    return; // Already streaming
  }

  // Clear any pending restart timeout since we are starting now
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }

  console.log(`Starting shared FFmpeg process for URL: ${url}`);
  
  // Spawn FFmpeg to decode the stream to PCM format, enabling automatic HTTP reconnection
  const currentFfmpeg = spawn(ffmpegPath, [
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-af', 'aresample=async=1',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ]);
  sharedFfmpegProcess = currentFfmpeg;

  currentFfmpeg.on('error', (err) => {
    console.error('Shared FFmpeg process error:', err);
  });

  currentFfmpeg.on('exit', (code, signal) => {
    console.log(`Shared FFmpeg process exited with code ${code} and signal ${signal}`);
    
    // Only handle cleanup/restarts if this exited process is the active one
    if (sharedFfmpegProcess === currentFfmpeg) {
      stopSharedStream();
      if (activeConnections.size > 0) {
        requestRestart(url);
      }
    }
  });

  sharedResource = createAudioResource(currentFfmpeg.stdout, {
    inputType: StreamType.Raw,
  });

  sharedPlayer.play(sharedResource);
}

// Helper to stop the shared stream
function stopSharedStream() {
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }
  
  try {
    sharedPlayer.stop();
  } catch (e) {
    console.error('Error stopping sharedPlayer:', e);
  }

  if (sharedFfmpegProcess) {
    try {
      const proc = sharedFfmpegProcess;
      sharedFfmpegProcess = null;
      proc.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing sharedFfmpegProcess:', e);
    }
  }
  sharedResource = null;
}

// Robust connection and auto-rejoin helper
async function connectToVoice(guildId, channelId, adapterCreator) {
  // If an existing connection tracking entry exists for this guild, mark manual disconnect so old listeners don't collide
  const existing = activeConnections.get(guildId);
  if (existing && existing.connection) {
    existing.isManualDisconnect = true;
    try { existing.connection.destroy(); } catch (e) {}
  }

  const connectionData = {
    connection: null,
    channelId,
    adapterCreator,
    isManualDisconnect: false,
  };

  const connection = joinVoiceChannel({
    channelId: channelId,
    guildId: guildId,
    adapterCreator: adapterCreator,
  });

  connectionData.connection = connection;
  activeConnections.set(guildId, connectionData);

  connection.on('stateChange', async (oldState, newState) => {
    console.log(`[Connection StateChange] Guild: ${guildId} | ${oldState.status} -> ${newState.status}`);
    
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      console.log(`Connection disconnected in guild: ${guildId}`);

      if (connectionData.isManualDisconnect) {
        return; // Manual disconnect initiated by user or replacement
      }

      // Try waiting up to 5 seconds for Discord automatic voice server migration or auto-reconnect
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log(`Connection auto-recovering in guild: ${guildId}`);
        return; // Auto-recovery succeeded
      } catch (e) {
        // Auto-recovery timed out
      }

      if (connectionData.isManualDisconnect) return;

      console.log(`Connection recovery timed out in guild: ${guildId}. Cleaning up old connection...`);
      try {
        connection.destroy();
      } catch (e) {}

      scheduleAutoRejoin(guildId, channelId, adapterCreator);
    }
  });

  // Wait for the connection to become Ready
  console.log(`Connecting to voice channel in guild: ${guildId}...`);
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log(`Connection ready in guild: ${guildId}! Subscribing player.`);

  // Subscribe to shared player
  connection.subscribe(sharedPlayer);

  // Ensure stream is running
  startSharedStream(streamUrl);

  return connection;
}

function scheduleAutoRejoin(guildId, channelId, adapterCreator) {
  const current = activeConnections.get(guildId);
  if (current && current.isManualDisconnect) {
    return; // Don't rejoin if user manually disconnected
  }

  console.log(`Scheduling auto-rejoin for guild: ${guildId} in 5 seconds...`);
  setTimeout(async () => {
    const entry = activeConnections.get(guildId);
    if (entry && entry.isManualDisconnect) {
      console.log(`Auto-rejoin cancelled for guild: ${guildId} due to manual disconnect.`);
      return;
    }

    try {
      console.log(`Attempting auto-rejoin in guild: ${guildId}...`);
      await connectToVoice(guildId, channelId, adapterCreator);
      console.log(`Successfully auto-rejoined voice channel in guild: ${guildId}!`);
    } catch (err) {
      console.error(`Auto-rejoin failed for guild: ${guildId}:`, err.message);
      const reCheck = activeConnections.get(guildId);
      if (!reCheck || !reCheck.isManualDisconnect) {
        scheduleAutoRejoin(guildId, channelId, adapterCreator);
      }
    }
  }, 5000);
}

// On Ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log('Registering global slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Successfully registered global slash commands!');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

// On Interaction
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'join') {
    const member = interaction.member;
    if (!member || !member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to use this command!', ephemeral: true });
    }

    const voiceChannel = member.voice.channel;
    const guildId = interaction.guildId;

    console.log(`User ${interaction.user.tag} (${interaction.user.id}) ran /join in guild: ${interaction.guild.name} (${guildId}), channel: ${voiceChannel.name} (${voiceChannel.id})`);

    await interaction.deferReply();

    try {
      await connectToVoice(guildId, voiceChannel.id, voiceChannel.guild.voiceAdapterCreator);
      await interaction.editReply(`Joined **${voiceChannel.name}** and started streaming the radio!`);
    } catch (error) {
      console.error('Error joining voice channel:', error);
      await interaction.editReply('Failed to join the voice channel.');
    }
  }

  if (commandName === 'disconnect') {
    const guildId = interaction.guildId;
    const connectionData = activeConnections.get(guildId);

    console.log(`User ${interaction.user.tag} (${interaction.user.id}) ran /disconnect in guild: ${interaction.guild.name} (${guildId})`);

    const connection = connectionData ? connectionData.connection : getVoiceConnection(guildId);

    if (!connection && !connectionData) {
      return interaction.reply({ content: 'I am not connected to a voice channel in this server!', ephemeral: true });
    }

    await interaction.deferReply();

    try {
      if (connectionData) {
        connectionData.isManualDisconnect = true;
      }
      if (connection) {
        try { connection.destroy(); } catch (e) {}
      }
      activeConnections.delete(guildId);

      if (activeConnections.size === 0) {
        console.log('All connections closed. Stopping shared stream.');
        stopSharedStream();
      }

      await interaction.editReply('Disconnected from the voice channel.');
    } catch (error) {
      console.error('Error disconnecting:', error);
      await interaction.editReply('Failed to disconnect properly.');
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down bot...');
  stopSharedStream();
  for (const item of activeConnections.values()) {
    if (item && item.connection) {
      item.isManualDisconnect = true;
      try { item.connection.destroy(); } catch (e) {}
    }
  }
  client.destroy();
  process.exit(0);
});

client.login(token).catch(console.error);
