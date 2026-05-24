package org.jspod.android

import android.provider.ContactsContract
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray

/**
 * Reads the device address book (requires the READ_CONTACTS runtime permission,
 * requested on the JS side before this is called) and returns it to JS as
 * [{ id, name, emails: [..], tels: [..] }]. The JS layer forwards the list over
 * the nodejs-mobile bridge, where it is written into the pod as vCard JSON-LD.
 *
 * Registered as a legacy ReactPackage (see ContactsPackage) — the same path
 * nodejs-mobile-react-native uses, so it works under bridgeless / new arch.
 */
class ContactsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "PodContacts"

    private class Entry(var name: String) {
        val emails = LinkedHashSet<String>()
        val tels = LinkedHashSet<String>()
    }

    @ReactMethod
    fun readContacts(promise: Promise) {
        try {
            val resolver = reactApplicationContext.contentResolver
            val byId = LinkedHashMap<String, Entry>()

            // Names (one row per aggregated contact).
            resolver.query(
                ContactsContract.Contacts.CONTENT_URI,
                arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
                null, null,
                ContactsContract.Contacts.DISPLAY_NAME + " COLLATE NOCASE ASC"
            )?.use { c ->
                val idIdx = c.getColumnIndex(ContactsContract.Contacts._ID)
                val nameIdx = c.getColumnIndex(ContactsContract.Contacts.DISPLAY_NAME)
                while (c.moveToNext()) {
                    val id = c.getString(idIdx) ?: continue
                    val name = if (nameIdx >= 0) c.getString(nameIdx) ?: "" else ""
                    byId[id] = Entry(name)
                }
            }

            // Phone numbers.
            resolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null, null, null
            )?.use { c ->
                val idIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val numIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (c.moveToNext()) {
                    val id = c.getString(idIdx) ?: continue
                    val num = if (numIdx >= 0) c.getString(numIdx)?.trim() else null
                    if (!num.isNullOrEmpty()) byId[id]?.tels?.add(num)
                }
            }

            // Email addresses.
            resolver.query(
                ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Email.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Email.ADDRESS
                ),
                null, null, null
            )?.use { c ->
                val idIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Email.CONTACT_ID)
                val addrIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Email.ADDRESS)
                while (c.moveToNext()) {
                    val id = c.getString(idIdx) ?: continue
                    val addr = if (addrIdx >= 0) c.getString(addrIdx)?.trim() else null
                    if (!addr.isNullOrEmpty()) byId[id]?.emails?.add(addr)
                }
            }

            val out: WritableArray = Arguments.createArray()
            for ((id, e) in byId) {
                if (e.name.isBlank() && e.emails.isEmpty() && e.tels.isEmpty()) continue
                val m = Arguments.createMap()
                m.putString("id", id)
                m.putString("name", e.name)
                val emails = Arguments.createArray(); e.emails.forEach { emails.pushString(it) }
                val tels = Arguments.createArray(); e.tels.forEach { tels.pushString(it) }
                m.putArray("emails", emails)
                m.putArray("tels", tels)
                out.pushMap(m)
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("READ_CONTACTS_FAILED", e.message, e)
        }
    }
}
