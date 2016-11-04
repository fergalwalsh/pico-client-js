var pico = require('./pico.js')
var test = require('blue-tape')

pico.loadAsync('http://127.0.0.1:4242/api')
.then(function (api) {
  test('hello test', function (t) {
    return api.hello('world')
    .then(function (value) {
      t.isEqual(value, 'Hello world')
    })
  })

  test('exception test', function (t) {
    return t.shouldFail(api.fail())
  })

  test('stream test', function (t) {
    var stream = api.countdown(3)
    var i = 0
    var results = ['2', '1', '0']
    stream.each(function (message) {
      t.isEqual(message, results[i])
      i += 1
    })
    .then(function () {
      t.end()
    })
  })

  test('pico.importModule test', function (t) {
    var m = pico.importModule('api')
    t.isEqual(m, api)

    return m.hello('Tester')
    .then(function (value) {
      t.isEqual(value, 'Hello Tester')
    })
  })

  test('pico.setAuthentication test', function (t) {
    api.current_user().then(function (value) {
      t.notOk(value)
    })

    pico.setAuthentication(api, 'bob', 'wrongpassword')
    t.shouldFail(api.current_user())
    pico.clearAuthentication(api)

    pico.setAuthentication(api, 'bob', 'secret')
    api.current_user()
    .then(function (value) {
      t.isEqual(value, 'bob')
    })
    pico.clearAuthentication(api)
    t.end()
  })
})

