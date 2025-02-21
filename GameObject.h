#ifndef GAME_OBJECT
#define GAME_OBJECT

#include <vector>
//#include <glm/glm.hpp>
//#include <glm/gtc/matrix_transform.hpp>
//#include <glm/gtc/type_ptr.hpp>
#include "Component.h"

class GameObject {
	std::vector<Component*> components;

public:
	void Update() {
		size_t num_components = components.size();

		for (size_t i = 0; i < num_components; i++)
		{
			components[i]->Update();
		}
	}

	// myGameObject.AddComponent<Transform>();
	// Returns nullptr if errors, component if succeeded
    template<class T>
    Component* AddComponent() {
        // Check if a component of type T already exists in vector
		//if (GetComponent<T>() != nullptr) { 
		//	return nullptr; 
		//}

        // If no component of type T exists, create a new one
        Component* new_component = new T;
        components.push_back(new_component);
        new_component->Start();
        return new_component;
    }
	
	// Transform* t = myGameObject.GetComponent<Transform>();
	// Returns nullptr if errors, component if succeeded
	template<class T>
	T* GetComponent() {
		size_t num_components = components.size();

		for (auto* component : components) {
			if (dynamic_cast<T*>(component) != nullptr) {
				return static_cast<T*>(component);  // Found a component of type T
			}
		}
		return nullptr;
	}


	//float Shape[15] = {
	//	// positions         // tex coords
	//	 0.5f, -0.5f, 1.0f,  0.0f, 0.0f,
	//	-0.5f, -0.5f, 1.0f,  1.0f, 0.0f,
	//	 0.0f,  0.5f, 1.0f,  0.5f, 1.0f,
	//};

	//unsigned int VBO, VAO;

	//GameObject() {
	//	components[0] = Component();

	//	glGenVertexArrays(1, &VAO);
	//	glGenBuffers(1, &VBO);
	//	glBindVertexArray(VAO);
	//	glBindBuffer(GL_ARRAY_BUFFER, VBO);
	//	glBufferData(GL_ARRAY_BUFFER, sizeof(Shape), Shape, GL_STATIC_DRAW);

	//	// position attribute
	//	glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void*)0);
	//	glEnableVertexAttribArray(0);
	//	// color attribute
	//	glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void*)(3 * sizeof(float)));
	//	glEnableVertexAttribArray(1);
	//}

	//void BindVertexArray() {
	//	glBindVertexArray(VAO);
	//}

	//~GameObject() {
	//	glDeleteVertexArrays(1, &VAO);
	//	glDeleteBuffers(1, &VBO);
	//}

	//void Scale(glm::vec3 factor) {
	//	glm::mat4 scale = glm::mat4(1.0f);

	//	scale = glm::scale(scale, factor);

	//	Shape = Shape * scale;
	//}
};

#endif