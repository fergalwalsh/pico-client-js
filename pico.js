require('isomorphic-fetch')
require('es6-promise').polyfill()
var EventSource = require('eventsource')
var FormData = require('form-data')

var fetch = global.fetch
var Request = global.Request

var modules = {}

var json = {
  dumps: function (obj) {
    return JSON.stringify(obj, function (k, v) {
      return v && typeof v === 'object' && typeof v.json === 'string' ? JSON.parse(v.json) : v
    })
  },
  loads: JSON.parse
}

function urlencode (params) {
  return Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k])
  }).join('&')
}

/**
 * Returns true of the object is a File or FileList
 * else false
 */
function isFileOrFilelist (obj) {
  return global.File && global.FileList && (obj instanceof global.File || obj instanceof global.FileList)
}

/**
 * Creates a namespace from a point-seperated string.
 */
function createNamespace (ns, root) {
  var m = root || global
  var parts = ns.split('.')
  var level

  for (var i = 0, l = parts.length; i < l; i++) {
    level = parts[i]
    m = (m[level] = m[level] || {})
  }
  return m
}

function createFunctionProxy (definition, functionName, obj) {
  var args = definition.args.map(function (arg) { return arg.name })

  var proxy = function () {
    var argsDict = {}
    var argValues = arguments
    args.forEach(function (arg, i) {
      argsDict[arg] = argValues[i]
    })
    var f = definition.stream ? stream : callFunctionWithArgs
    return f(obj, functionName, argsDict)
  }

  proxy.submitFormData = function (form) {
    return callFunction(obj, functionName, form)
  }

  proxy.submitJSON = function (data) {
    return callFunction(obj, functionName, json.dumps(data))
  }

  proxy.url = definition.url

  // generate doc string
  proxy.__doc__ = 'function(' + args.join(', ') + ')'
  if (definition.doc) {
    proxy.__doc__ = [proxy.__doc__, definition.doc].join('\n')
  }

  proxy.toString = function () {
    return this.__doc__
  }

  return proxy
}

function createModuleProxy (definition, moduleName, alias) {
  if (alias === undefined) {
    alias = moduleName
  }
  var ns = createNamespace(alias, {})
  for (var k in ns) {
    delete ns[k]
  }
  ns.__name__ = definition.name
  ns.__alias__ = alias
  ns.__url__ = definition.url
  ns.__doc__ = definition.doc
  ns._request_hooks = {}
  for (var i = 0; i < definition.functions.length; i++) {
    var funcDef = definition.functions[i]
    var funcName = funcDef.name
    ns[funcName] = createFunctionProxy(funcDef, funcName, ns)
  }
  return ns
};

function callFunctionWithArgs (obj, functionName, argsDict) {
  var data = new FormData()
  Object.keys(argsDict).forEach(function (k) {
    var v = isFileOrFilelist(argsDict[k]) ? argsDict[k] : json.dumps(argsDict[k])
    data.append(k, v)
  })
  return callFunction(obj, functionName, data)
}

function callFunction (obj, functionName, data) {
  var promise = new Promise(function (resolve, reject) {
    var url = obj[functionName].url

    var request = new Request(url, {
      method: 'POST',
      body: data,
      headers: {
        'Accept': 'application/json'
      },
      credentials: 'include'
    })
    if (!(data instanceof FormData)) {
      request.headers.set('Content-Type', 'application/json')
    }
    for (var k in obj._request_hooks) {
      var hook = obj._request_hooks[k]
      hook(request)
    }

    fetch(request)
    .then(function (response) {
      if (response.ok) {
        return response
      } else {
        if (response.headers.get('Content-Type') === 'application/json') {
          return response.json().then(function (r) {
            var error = new Error(r.message)
            error.code = r.code
            error.name = r.name
            throw error
          })
        } else {
          var error = new Error(response.statusText)
          error.code = response.status
          throw error
        }
      }
    })
    .then(function (response) { return response.json() })
    .then(resolve)
    .catch(reject)
  })
  return promise
}

function setRequestHook (obj, name, hook) {
  obj._request_hooks[name] = hook
}

function clearRequestHook (obj, name) {
  delete obj._request_hooks[name]
}

function stream (obj, functionName, argsDict) {
  var url = obj[functionName].url
  var stream = {}
  stream.buffer = []
  stream.max_buffer_size = 100
  stream.open = function () {
    url = url + '?' + urlencode(argsDict)
    stream.socket = new EventSource(url)
    stream.socket.addEventListener('message', function (e) {
      stream.handler(JSON.parse(e.data))
    })
    stream.socket.addEventListener('close', function (e) {
      stream.closehandler(e.data)
      stream.socket.close()
    })
    stream.socket.addEventListener('error', function (e) {
      stream.errorhandler(e.data)
      stream.socket.close()
    })
    return stream
  }
  stream.close = function () {
    stream.socket.close()
    stream.closehandler()
  }
  stream.status = function () {
    var states = ['Connecting', 'Open', 'Closed']
    return states[stream.socket.readyState]
  }
  stream.handler = function (message) {
    if (stream.buffer.length > stream.max_buffer_size) {
      console.warn('Max stream buffer length exceeded. Discarding oldest message.')
      stream.buffer.shift()
    }
    stream.buffer.push(message)
  }
  stream.errorhandler = function (e) {
    console.error(e)
  }
  stream.closehandler = function () {

  }
  stream.each = function (handler) {
    stream.handler = handler
    while (stream.buffer.length) {
      handler(stream.buffer.shift())
    }
    return stream
  }
  stream.catch = function (handler) {
    stream.errorhandler = handler
    return stream
  }
  stream.then = function (handler) {
    stream.closehandler = handler
    return stream
  }
  stream.open()
  return stream
}

function loadModuleDefinition (definition) {
  var module = createModuleProxy(definition, definition.name)
  //  for imports by absolute url: example.com/blog/api
  modules[module.__url__.split('//')[1]] = module
  //  for imports by dotted name: blog.api
  modules[module.__name__.replace('/', '.')] = module
  return module
}

function importModule (moduleName) {
  if (moduleName.indexOf('/') > -1) {
    var parts = moduleName.split('//')
    moduleName = parts[parts.length - 1]
  }
  return modules[moduleName]
}

exports.importModule = importModule

exports.loadAsync = function (moduleUrl) {
  var promise = new Promise(function (resolve, reject) {
    fetch(moduleUrl)
      .then(function (response) { return response.json() })
      .then(function (definition) {
        resolve(loadModuleDefinition(definition, definition.name))
      })
      .catch(reject)
  })
  return promise
}

exports.loadModuleDefinition = loadModuleDefinition

exports.loadAppDefinition = function (definition) {
  var app = createNamespace('app')
  for (var i = 0; i < definition.modules.length; i++) {
    var moduleDef = definition.modules[i]
    app[moduleDef.name] = createModuleProxy(moduleDef, moduleDef.name)
  }
  return app
}

exports.setRequestHook = setRequestHook

exports.clearRequestHook = clearRequestHook

exports.setAuthentication = function (object, username, password) {
  var authString = username + ':' + password
  var buf = Buffer.from(authString)
  var b64 = buf.toString('base64')
  setRequestHook(object, 'auth', function (req) {
    req.headers.set('Authorization', 'Basic ' + b64)
  })
}

exports.clearAuthentication = function (object) {
  clearRequestHook(object, 'auth')
}

