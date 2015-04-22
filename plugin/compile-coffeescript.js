var fs = Npm.require('fs');
var path = Npm.require('path');
var coffee = Npm.require('coffee-script');
var _ = Npm.require('underscore');
var sourcemap = Npm.require('source-map');

var stripExportedVars = function (source, exports) {
  if (!exports || _.isEmpty(exports))
    return source;
  var lines = source.split("\n");

  // We make the following assumptions, based on the output of CoffeeScript
  // 1.7.1.
  //   - The var declaration in question is not indented and is the first such
  //     var declaration.  (CoffeeScript only produces one var line at each
  //     scope and there's only one top-level scope.)  All relevant variables
  //     are actually on this line.
  //   - The user hasn't used a ###-comment containing a line that looks like
  //     a var line, to produce something like
  //        /* bla
  //        var foo;
  //        */
  //     before an actual var line.  (ie, we do NOT attempt to figure out if
  //     we're inside a /**/ comment, which is produced by ### comments.)
  //   - The var in question is not assigned to in the declaration, nor are any
  //     other vars on this line. (CoffeeScript does produce some assignments
  //     but only for internal helpers generated by CoffeeScript, and they end
  //     up on subsequent lines.)
  // XXX relax these assumptions by doing actual JS parsing (eg with jsparse).
  //     I'd do this now, but there's no easy way to "unparse" a jsparse AST.
  //     Or alternatively, hack the compiler to allow us to specify unbound
  //     symbols directly.

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var match = /^var (.+)([,;])$/.exec(line);
    if (!match)
      continue;

    // If there's an assignment on this line, we assume that there are ONLY
    // assignments and that the var we are looking for is not declared. (Part
    // of our strong assumption about the layout of this code.)
    if (match[1].indexOf('=') !== -1)
      continue;

    // We want to replace the line with something no shorter, so that all
    // records in the source map continue to point at valid
    // characters.
    var replaceLine = function (x) {
      if (x.length >= lines[i].length) {
        lines[i] = x;
      } else {
        lines[i] = x + new Array(1 + (lines[i].length - x.length)).join(' ');
      }
    };

    var vars = match[1].split(', ');
    vars = _.difference(vars, exports);
    if (!_.isEmpty(vars)) {
      replaceLine("var " + vars.join(', ') + match[2]);
    } else {
      // We got rid of all the vars on this line. Drop the whole line if this
      // didn't continue to the next line, otherwise keep just the 'var '.
      if (match[2] === ';')
        replaceLine('');
      else
        replaceLine('var');
    }
    break;
  }

  return lines.join('\n');
};

var addSharedHeader = function (source, sourceMap) {
  var sourceMapJSON = JSON.parse(sourceMap);

  // We want the symbol "share" to be visible to all CoffeeScript files in the
  // package (and shared between them), but not visible to JavaScript
  // files. (That's because we don't want to introduce two competing ways to
  // make package-local variables into JS ("share" vs assigning to non-var
  // variables).) The following hack accomplishes that: "__coffeescriptShare"
  // will be visible at the package level and "share" at the file level.  This
  // should work both in "package" mode where __coffeescriptShare will be added
  // as a var in the package closure, and in "app" mode where it will end up as
  // a global.
  //
  // This ends in a newline to make the source map easier to adjust.
  var header = ("__coffeescriptShare = typeof __coffeescriptShare === 'object' " +
                "? __coffeescriptShare : {}; " +
                "var share = __coffeescriptShare;\n");

  // If the file begins with "use strict", we need to keep that as the first
  // statement.
  source = source.replace(/^(?:((['"])use strict\2;)\n)?/, function (match, useStrict) {
    if (match) {
      // There's a "use strict"; we keep this as the first statement and insert
      // our header at the end of the line that it's on. This doesn't change
      // line numbers or the part of the line that previous may have been
      // annotated, so we don't need to update the source map.
      return useStrict + "  " + header;
    } else {
      // There's no use strict, so we can just add the header at the very
      // beginning. This adds a line to the file, so we update the source map to
      // add a single un-annotated line to the beginning.
      sourceMapJSON.mappings = ";" + sourceMapJSON.mappings;
      return header;
    }
  });
  return {
    source: source,
    sourceMap: JSON.stringify(sourceMapJSON)
  };
};

var addWrapper = function (source, sourceMap, filepath, wrapper) {
  // Find the file's name from the filepath
  name = path.basename(filepath, '.' + wrapper + '.coffee');

  var header = "Template." + name + "." + wrapper;

  // We find all instances of CoffeeScripts's helper
  // functions (such as __indexOf), and the file's
  // "use strict" if it has one. We put our header
  // on the line after these.
  source = source.replace(/^((?:(?:(['"])use strict\2;\n+)|(?:var.*;\n+))+)/,
    '$1' + header);

  // Coffescript would normally open a file whose body is an 
  // object with a "({" line. We add our header on this line,
  // turining it into a function call. We don't move stuff
  // between lines, so there is no need to modify the sourceMap.
  return {
    source: source,
    sourceMap: sourceMap
  };
}

var handler = function (compileStep, isLiterate, templateWrapper) {
  var source = compileStep.read().toString('utf8');
  var outputFile = compileStep.inputPath + ".js";

  var options = {
    bare: true,
    filename: compileStep.inputPath,
    literate: !!isLiterate,
    // Return a source map.
    sourceMap: true,
    // Include the original source in the source map (sourcesContent field).
    inline: true,
    // This becomes the "file" field of the source map.
    generatedFile: "/" + outputFile,
    // This becomes the "sources" field of the source map.
    sourceFiles: [compileStep.pathForSourceMap]
  };

  try {
    var output = coffee.compile(source, options);
  } catch (e) {
    // XXX better error handling, once the Plugin interface support it
    throw new Error(
      compileStep.inputPath + ':' +
      (e.location ? (e.location.first_line + ': ') : ' ') +
      e.message
    );
  }

  var stripped = stripExportedVars(output.js, compileStep.declaredExports);
  var sourceWithMap;

  if (templateWrapper){
    sourceWithMap = addWrapper(stripped, output.v3SourceMap, compileStep.inputPath, templateWrapper);
    sourceWithMap = addSharedHeader(sourceWithMap.source, sourceWithMap.sourceMap);
  } else {
    sourceWithMap = addSharedHeader(stripped, output.v3SourceMap);
  }

  compileStep.addJavaScript({
    path: outputFile,
    sourcePath: compileStep.inputPath,
    data: sourceWithMap.source,
    sourceMap: sourceWithMap.sourceMap,
    bare: compileStep.fileOptions.bare
  });
};

var literateHandler = function (compileStep) {
  return handler(compileStep, true);
};

var helpersHandler = function (compileStep) {
  return handler(compileStep, false, 'helpers');
};

var eventsHandler = function (compileStep) {
  return handler(compileStep, false, 'events');
};

Plugin.registerSourceHandler("coffee", handler);
Plugin.registerSourceHandler("litcoffee", literateHandler);
Plugin.registerSourceHandler("coffee.md", literateHandler);
Plugin.registerSourceHandler("helpers.coffee", helpersHandler);
Plugin.registerSourceHandler("events.coffee", eventsHandler);