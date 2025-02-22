// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import {
  ConfigurationFile,
  IJsonPathMetadataResolverOptions,
  InheritanceType,
  PathResolutionMethod
} from '@rushstack/heft-config-file';
import { Import, ITerminal } from '@rushstack/node-core-library';
import type { RigConfig } from '@rushstack/rig-package';

import type { IDeleteOperation } from '../plugins/DeleteFilesPlugin';
import type { INodeServicePluginConfiguration } from '../plugins/NodeServicePlugin';
import { Constants } from './Constants';

export type HeftEventKind = 'copyFiles' | 'deleteFiles' | 'runScript' | 'nodeService';

export interface IHeftConfigurationJsonEventSpecifier {
  eventKind: HeftEventKind;
  options?: object;
}

export interface IHeftConfigurationJsonPluginSpecifier {
  pluginPackage: string;
  pluginPackageRoot: string;
  pluginName?: string;
  options?: object;
}

export interface IHeftConfigurationJsonTaskSpecifier {
  taskDependencies?: string[];
  taskEvent?: IHeftConfigurationJsonEventSpecifier;
  taskPlugin?: IHeftConfigurationJsonPluginSpecifier;
}

export interface IHeftConfigurationJsonTasks {
  [taskName: string]: IHeftConfigurationJsonTaskSpecifier;
}

export interface IHeftConfigurationJsonPhaseSpecifier {
  phaseDescription?: string;
  phaseDependencies?: string[];
  cleanFiles?: IDeleteOperation[];
  tasksByName?: IHeftConfigurationJsonTasks;
}

export interface IHeftConfigurationJsonPhases {
  [phaseName: string]: IHeftConfigurationJsonPhaseSpecifier;
}

export interface IHeftConfigurationJson {
  heftPlugins?: IHeftConfigurationJsonPluginSpecifier[];
  phasesByName?: IHeftConfigurationJsonPhases;
}

export class CoreConfigFiles {
  private static _heftConfigFileLoader: ConfigurationFile<IHeftConfigurationJson> | undefined;
  private static _nodeServiceConfigurationLoader:
    | ConfigurationFile<INodeServicePluginConfiguration>
    | undefined;

  /**
   * Returns the loader for the `config/heft.json` config file.
   */
  public static async loadHeftConfigurationFileForProjectAsync(
    terminal: ITerminal,
    projectPath: string,
    rigConfig?: RigConfig | undefined
  ): Promise<IHeftConfigurationJson> {
    if (!CoreConfigFiles._heftConfigFileLoader) {
      const pluginPackageResolver: (
        options: IJsonPathMetadataResolverOptions<IHeftConfigurationJson>
      ) => string = (options: IJsonPathMetadataResolverOptions<IHeftConfigurationJson>) => {
        const { propertyValue, configurationFilePath } = options;
        const configurationFileDirectory: string = path.dirname(configurationFilePath);
        return Import.resolvePackage({
          packageName: propertyValue,
          baseFolderPath: configurationFileDirectory
        });
      };

      const schemaPath: string = path.join(__dirname, '..', 'schemas', 'heft.schema.json');
      CoreConfigFiles._heftConfigFileLoader = new ConfigurationFile<IHeftConfigurationJson>({
        projectRelativeFilePath: `${Constants.projectConfigFolderName}/${Constants.heftConfigurationFilename}`,
        jsonSchemaPath: schemaPath,
        propertyInheritanceDefaults: {
          array: { inheritanceType: InheritanceType.append },
          object: { inheritanceType: InheritanceType.merge }
        },
        jsonPathMetadata: {
          // Use a custom resolver for the plugin packages, since the NodeResolve algorithm will resolve to the
          // package.json exports/module property, which may or may not exist.
          '$.heftPlugins.*.pluginPackage': {
            pathResolutionMethod: PathResolutionMethod.custom,
            customResolver: pluginPackageResolver
          },
          // Use a custom resolver for the plugin packages, since the NodeResolve algorithm will resolve to the
          // package.json exports/module property, which may or may not exist.
          '$.phasesByName.*.tasksByName.*.taskPlugin.pluginPackage': {
            pathResolutionMethod: PathResolutionMethod.custom,
            customResolver: pluginPackageResolver
          },
          // Special handling for "runScript" task events to resolve the script path
          '$.phasesByName.*.tasksByName[?(@.taskEvent && @.taskEvent.eventKind == "runScript")].taskEvent.options.scriptPath':
            {
              pathResolutionMethod: PathResolutionMethod.resolvePathRelativeToProjectRoot
            }
        }
      });
    }

    const configurationFile: IHeftConfigurationJson =
      await CoreConfigFiles._heftConfigFileLoader.loadConfigurationFileForProjectAsync(
        terminal,
        projectPath,
        rigConfig
      );

    // The pluginPackage field was resolved to the root of the package, but we also want to have
    // the original plugin package name in the config file. Gather all the plugin specifiers so we can
    // add the original data ourselves.
    const pluginSpecifiers: IHeftConfigurationJsonPluginSpecifier[] = [
      ...(configurationFile.heftPlugins || [])
    ];
    for (const { tasksByName } of Object.values(configurationFile.phasesByName || {})) {
      for (const { taskPlugin } of Object.values(tasksByName || {})) {
        if (taskPlugin) {
          pluginSpecifiers.push(taskPlugin);
        }
      }
    }

    for (const pluginSpecifier of pluginSpecifiers) {
      const pluginPackageName: string = CoreConfigFiles._heftConfigFileLoader.getPropertyOriginalValue({
        parentObject: pluginSpecifier,
        propertyName: 'pluginPackage'
      })!;
      pluginSpecifier.pluginPackageRoot = pluginSpecifier.pluginPackage;
      pluginSpecifier.pluginPackage = pluginPackageName;
    }

    return configurationFile;
  }

  public static get nodeServiceConfigurationFile(): ConfigurationFile<INodeServicePluginConfiguration> {
    if (!CoreConfigFiles._nodeServiceConfigurationLoader) {
      const schemaPath: string = path.resolve(__dirname, '..', 'schemas', 'node-service.schema.json');
      CoreConfigFiles._nodeServiceConfigurationLoader =
        new ConfigurationFile<INodeServicePluginConfiguration>({
          projectRelativeFilePath: `${Constants.projectConfigFolderName}/${Constants.nodeServiceConfigurationFilename}`,
          jsonSchemaPath: schemaPath
        });
    }
    return CoreConfigFiles._nodeServiceConfigurationLoader;
  }
}
