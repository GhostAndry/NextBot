'use strict';
const { MessageFlags } = require('discord.js');

const { getCommand } = require('../handlers/registry');
const logger = require('../utils/logger');

// Dispatcher for slash commands, components, modals, and autocomplete.
// For components we look up the originating command by the customId prefix
// (`<commandName>:<action>`) so each command owns its own button/menu/modal.

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (!interaction.guildId) return;

    if (interaction.isChatInputCommand() || interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
      return dispatchCommand(interaction);
    }

    if (interaction.isAutocomplete()) {
      return dispatchAutocomplete(interaction);
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return dispatchComponent(interaction);
    }

    if (interaction.isModalSubmit()) {
      return dispatchModal(interaction);
    }
  },
};

async function dispatchCommand(interaction) {
  const cmd = getCommand(interaction.commandName);
  if (!cmd) {
    logger.warn({ cmd: interaction.commandName }, 'unknown command');
    return interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }

  try {
    await cmd.execute(interaction);
  } catch (err) {
    logger.error({ err, cmd: interaction.commandName }, 'command execution failed');
    await safeErrorReply(interaction, 'Command error.');
  }
}

async function dispatchComponent(interaction) {
  const commandName = (interaction.customId || '').split(':')[0];
  const cmd = getCommand(commandName);
  if (!cmd || typeof cmd.handleComponent !== 'function') return;

  try {
    await cmd.handleComponent(interaction);
  } catch (err) {
    logger.error({ err, id: interaction.customId }, 'component handler error');
  }
}

async function dispatchModal(interaction) {
  const commandName = (interaction.customId || '').split(':')[0];
  const cmd = getCommand(commandName);
  if (!cmd || typeof cmd.handleModal !== 'function') return;

  try {
    await cmd.handleModal(interaction);
  } catch (err) {
    logger.error({ err, id: interaction.customId }, 'modal handler error');
  }
}

async function dispatchAutocomplete(interaction) {
  const cmd = getCommand(interaction.commandName);
  if (!cmd || typeof cmd.autocomplete !== 'function') return;

  try {
    await cmd.autocomplete(interaction);
  } catch (err) {
    logger.error({ err, cmd: interaction.commandName }, 'autocomplete handler error');
  }
}

async function safeErrorReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {}
}
